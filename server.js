const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const multer = require('multer');
const fs = require('fs');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configuración archivos
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

// base de datos
const db = new sqlite3.Database('./medicina_v8.db'); 

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE, password TEXT, name TEXT, role TEXT, description TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS cases (id INTEGER PRIMARY KEY, title TEXT, description TEXT, age TEXT, gender TEXT, event_date TEXT, code TEXT UNIQUE, instructor_id INTEGER)`);
    db.run(`CREATE TABLE IF NOT EXISTS case_members (case_id INTEGER, user_id INTEGER, grade INTEGER DEFAULT 0)`);
    
    db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, case_id INTEGER, user_name TEXT, user_id INTEGER, content TEXT, timestamp TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS case_files (id INTEGER PRIMARY KEY, case_id INTEGER, filename TEXT, original_name TEXT, uploader_name TEXT, uploader_id INTEGER, timestamp TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, user_id INTEGER, message TEXT, is_read INTEGER DEFAULT 0, timestamp TEXT)`);

    // Datos para q cualquiera inicie sesión
    db.get("SELECT count(*) as count FROM users", (err, row) => {
        if (row.count === 0) {
            console.log("Creando usuarios...");
            db.run(`INSERT INTO users (email, password, name, role, description) VALUES ('prof@test.com', '123', 'Dr. House', 'instructor', 'Jefe de Diagnóstico')`);
            db.run(`INSERT INTO users (email, password, name, role, description) VALUES ('alumno@test.com', '123', 'Juan Pérez', 'estudiante', 'Residente')`);
        }
    });
});

// api

// login, registro y perfil
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    db.get("SELECT * FROM users WHERE email = ? AND password = ?", [email, password], (err, row) => {
        if (!row) return res.status(401).json({ success: false, message: "Error de credenciales" });
        res.json({ success: true, user: row });
    });
});
app.post('/api/register', (req, res) => {
    const { name, email, password, role } = req.body;
    db.run("INSERT INTO users (name, email, password, role, description) VALUES (?, ?, ?, ?, '')", [name, email, password, role], (err) => res.json({ success: !err }));
});
app.get('/api/user-profile/:id', (req, res) => { db.get("SELECT id, name, email, role, description FROM users WHERE id = ?", [req.params.id], (err, row) => res.json(row)); });
app.post('/api/update-profile', (req, res) => { const { userId, description } = req.body; db.run("UPDATE users SET description = ? WHERE id = ?", [description, userId], (err) => res.json({ success: !err })); });
app.post('/api/change-password', (req, res) => { const { userId, newPassword } = req.body; db.run("UPDATE users SET password = ? WHERE id = ?", [newPassword, userId], (err) => res.json({ success: !err })); });

// casos crear unirse
app.post('/api/create-case', upload.single('pdf'), (req, res) => {
    const { title, description, age, gender, eventDate, instructorId } = req.body;
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    db.run("INSERT INTO cases (title, description, age, gender, event_date, code, instructor_id) VALUES (?, ?, ?, ?, ?, ?, ?)", [title, description, age, gender, eventDate, code, instructorId], function(err) {
        if (req.file) {
            const time = new Date().toLocaleDateString();
            db.run("INSERT INTO case_files (case_id, filename, original_name, uploader_name, uploader_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)", [this.lastID, req.file.filename, req.file.originalname, "Instructor", instructorId, time]);
        }
        res.json({ success: true, code: code });
    });
});

app.post('/api/join-case', (req, res) => {
    const { code, userId } = req.body;
    db.get("SELECT id, title, instructor_id FROM cases WHERE code = ?", [code], (err, caseRow) => {
        if (!caseRow) return res.json({ success: false, message: "Código inválido" });
        db.get("SELECT name FROM users WHERE id = ?", [userId], (err, userRow) => {
            const userName = userRow ? userRow.name : "Un alumno";
            db.get("SELECT * FROM case_members WHERE case_id = ? AND user_id = ?", [caseRow.id, userId], (err, member) => {
                if (member) return res.json({ success: false, message: "Ya estás unido" });
                
                // Unir con calificación 0 inicial
                db.run("INSERT INTO case_members (case_id, user_id, grade) VALUES (?, ?, 0)", [caseRow.id, userId], () => {
                    const notifMsg = `${userName} se ha unido a tu caso: "${caseRow.title}"`;
                    const time = new Date().toLocaleTimeString();
                    db.run("INSERT INTO notifications (user_id, message, timestamp) VALUES (?, ?, ?)", [caseRow.instructor_id, notifMsg, time], function() {
                        io.to(`user_${caseRow.instructor_id}`).emit('notification_received', { id: this.lastID, message: notifMsg, timestamp: time, is_read: 0 });
                    });
                    res.json({ success: true, caseId: caseRow.id });
                });
            });
        });
    });
});

app.post('/api/my-cases', (req, res) => {
    const { userId, role } = req.body;
    if (role === 'instructor') {
        db.all("SELECT * FROM cases WHERE instructor_id = ?", [userId], (err, rows) => res.json(rows));
    } else {
        db.all(`SELECT c.*, cm.grade FROM cases c 
                JOIN case_members cm ON c.id = cm.case_id 
                WHERE cm.user_id = ?`, [userId], (err, rows) => res.json(rows));
    }
});

app.get('/api/case-students/:caseId', (req, res) => {
    db.all(`SELECT u.id, u.name, cm.grade 
            FROM users u 
            JOIN case_members cm ON u.id = cm.user_id 
            WHERE cm.case_id = ?`, [req.params.caseId], (err, rows) => {
        res.json(rows);
    });
});

// calificar al estudainte
app.post('/api/update-grade', (req, res) => {
    const { caseId, studentId, grade } = req.body;
    db.run("UPDATE case_members SET grade = ? WHERE case_id = ? AND user_id = ?", [grade, caseId, studentId], function(err) {
        if(err) return res.json({success: false});
        
        // notificar al alumno
        const notifMsg = `Tu calificación en el caso ha sido actualizada a: ${grade}`;
        const time = new Date().toLocaleTimeString();
        db.run("INSERT INTO notifications (user_id, message, timestamp) VALUES (?, ?, ?)", [studentId, notifMsg, time], function() {
             io.to(`user_${studentId}`).emit('notification_received', { id: this.lastID, message: notifMsg, timestamp: time, is_read: 0 });
        });
        
        res.json({ success: true });
    });
});

// RESTO DE RUTAS Notificaciones, Archivos, Chat y Edit
app.get('/api/notifications/:userId', (req, res) => { db.all("SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 20", [req.params.userId], (err, rows) => res.json(rows)); });
app.post('/api/notifications/mark-read', (req, res) => { db.run("UPDATE notifications SET is_read = 1 WHERE user_id = ?", [req.body.userId], () => res.json({ success: true })); });
app.post('/api/edit-case', (req, res) => { const { id, title, description, age, gender, eventDate } = req.body; db.run("UPDATE cases SET title=?, description=?, age=?, gender=?, event_date=? WHERE id=?", [title, description, age, gender, eventDate, id], () => { io.to(id.toString()).emit('case_updated'); res.json({ success: true }); }); });
app.post('/api/upload-file', upload.single('file'), (req, res) => { /*...*/ const { caseId, uploaderName, uploaderId } = req.body; if(!req.file) return res.json({success: false}); db.run("INSERT INTO case_files (case_id, filename, original_name, uploader_name, uploader_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)", [caseId, req.file.filename, req.file.originalname, uploaderName, uploaderId, new Date().toLocaleDateString()], () => { io.to(caseId).emit('file_uploaded'); res.json({success: true}); }); });
app.post('/api/delete-file', (req, res) => { /*...*/ const { fileId, userId, userRole } = req.body; db.get("SELECT * FROM case_files WHERE id = ?", [fileId], (err, file) => { if((userRole === 'instructor') || (parseInt(file.uploader_id) === parseInt(userId))) { db.run("DELETE FROM case_files WHERE id = ?", [fileId], () => { io.to(file.case_id.toString()).emit('file_uploaded'); res.json({success: true}); }); } else res.json({success: false}); }); });
app.get('/api/case-files/:id', (req, res) => { db.all("SELECT * FROM case_files WHERE case_id = ?", [req.params.id], (err, rows) => res.json(rows)); });
app.get('/api/case-details/:id', (req, res) => { db.get("SELECT * FROM cases WHERE id = ?", [req.params.id], (err, row) => res.json(row)); });
app.get('/api/messages/:caseId', (req, res) => { db.all("SELECT * FROM messages WHERE case_id = ?", [req.params.caseId], (err, rows) => res.json(rows)); });

io.on('connection', (socket) => {
    socket.on('login_user', (userId) => socket.join(`user_${userId}`));
    socket.on('join_case', (id) => socket.join(id));
    socket.on('send_message', (d) => { /*...*/ const time = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}); db.run("INSERT INTO messages (case_id, user_name, user_id, content, timestamp) VALUES (?,?,?,?,?)", [d.caseId, d.user, d.userId, d.text, time]); io.to(d.caseId).emit('new_message', { ...d, timestamp: time }); });
});

http.listen(3000, () => console.log('CORRIENDO EN http://localhost:3000'));