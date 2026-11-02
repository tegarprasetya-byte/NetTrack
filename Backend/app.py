import os
import re
from flask import Flask, request, send_from_directory
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_cors import CORS
import mysql.connector

# Folder frontend
frontend_folder = os.path.abspath(os.path.join(os.path.dirname(__file__), '../frontend'))

app = Flask(__name__, static_folder=frontend_folder, static_url_path='')
app.config['SECRET_KEY'] = 'nettrack_secret_key'
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

# Konfigurasi Database MySQL (Laragon)
db_config = {
    'host': 'localhost',
    'user': 'root',
    'password': '',
    'database': 'nettrack_db'
}

online_users = {}  # { request.sid: {'user_id': ..., 'user_name': ...} }
ID_PATTERN = re.compile(r'^[A-Za-z0-9_]{3,30}$')

# 1 frame = start 0 + 7 bit data + 1 bit parity + end 1 (kelipatan 10 bit)
FRAME_PATTERN = re.compile(r'(?:0[01]{8}1)+')

def get_db_connection():
    try:
        return mysql.connector.connect(**db_config)
    except mysql.connector.Error as err:
        print(f"-> [ERROR DATABASE CONNECTION]: {err}")
        return None

def get_active_online_user_ids():
    """Mengembalikan daftar user_id unik yang sedang online."""
    return list(set(u['user_id'] for u in online_users.values() if 'user_id' in u))

# ==========================================
# ROUTE FILE STATIC FRONTEND
# ==========================================
@app.route('/')
def serve_index():
    return send_from_directory(frontend_folder, 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory(frontend_folder, path)

# ==========================================
# EVENT SOCKET.IO: AUTENTIKASI
# ==========================================
@socketio.on('register_account')
def handle_register_account(data):
    data = data or {}
    user_id = (data.get('user_id') or '').strip().lower()
    user_name = (data.get('user_name') or '').strip()
    email_bin = (data.get('email') or '').strip()
    password_bin = data.get('password') or ''
    access_key_bin = data.get('access_key') or ''

    if not user_id or not user_name or not email_bin or not password_bin or not access_key_bin:
        emit('auth_response', {'status': 'error', 'message': 'Semua kolom wajib diisi!'})
        return
    if not ID_PATTERN.match(user_id):
        emit('auth_response', {'status': 'error', 'message': 'ID hanya boleh huruf, angka, dan underscore (3-30 karakter)!'})
        return

    conn = get_db_connection()
    if not conn:
        emit('auth_response', {'status': 'error', 'message': 'Server tidak terhubung ke database!'})
        return

    try:
        cursor = conn.cursor()

        email_bytes = email_bin.encode('utf-8')
        password_bytes = password_bin.encode('utf-8')
        access_key_bytes = access_key_bin.encode('utf-8')

        cursor.execute("SELECT 1 FROM users WHERE user_id = %s OR email = %s LIMIT 1", (user_id, email_bytes))
        if cursor.fetchone():
            emit('auth_response', {'status': 'error', 'message': 'ID atau Email sudah digunakan!'})
            return

        cursor.execute(
            """
            INSERT INTO users (user_id, username, email, password, access_key, created_at)
            VALUES (%s, %s, %s, %s, %s, NOW())
            """,
            (user_id, user_name, email_bytes, password_bytes, access_key_bytes)
        )
        conn.commit()
        print(f"-> [REGISTER SUCCESS] {user_name} ({user_id})")
        emit('auth_response', {
            'status': 'success',
            'action': 'register',
            'message': 'Registrasi berhasil! Silakan login.'
        })
    except Exception as e:
        print(f"-> [ERROR REGISTER]: {e}")
        emit('auth_response', {'status': 'error', 'message': 'Terjadi kesalahan sistem saat registrasi.'})
    finally:
        conn.close()

@socketio.on('login_account')
def handle_login_account(data):
    data = data or {}
    email_bin = (data.get('email') or '').strip()
    password_bin = data.get('password') or ''

    conn = get_db_connection()
    if not conn:
        emit('auth_response', {'status': 'error', 'message': 'Server tidak terhubung ke database!'})
        return

    try:
        cursor = conn.cursor(dictionary=True)

        email_bytes = email_bin.encode('utf-8')

        cursor.execute("SELECT user_id, username, password FROM users WHERE email = %s LIMIT 1", (email_bytes,))
        user = cursor.fetchone()

        db_password = user['password'] if user else None
        if isinstance(db_password, (bytes, bytearray)):
            db_password = db_password.decode('utf-8', errors='ignore')

        if not (user and db_password == password_bin):
            emit('auth_response', {'status': 'error', 'message': 'Email atau Password salah!'})
            return

        user_id = user['user_id']
        user_name = user['username']

        cursor.execute("UPDATE users SET last_login = NOW() WHERE user_id = %s", (user_id,))
        conn.commit()

        # Ambil riwayat chat (kolom message bertipe LONGBLOB)
        cursor.execute(
            """
            SELECT m.sender_id, m.sender_name, m.receiver_id,
                   u.username AS receiver_name, m.message, m.created_at
            FROM messages m
            LEFT JOIN users u ON u.user_id = m.receiver_id
            WHERE m.sender_id = %s OR m.receiver_id = %s
            ORDER BY m.created_at ASC, m.id ASC
            """,
            (user_id, user_id)
        )
        history = cursor.fetchall()
        for row in history:
            if row['created_at']:
                row['created_at'] = row['created_at'].isoformat()

            # bytes -> string, TANPA strip(): kalau ada karakter nyasar,
            # biar ketahuan oleh validasi di client
            if isinstance(row['message'], (bytes, bytearray)):
                row['message'] = row['message'].decode('utf-8', errors='ignore')

        old = online_users.get(request.sid)
        if old:
            leave_room(old['user_id'])
        online_users[request.sid] = {'user_id': user_id, 'user_name': user_name}
        join_room(user_id)

        print(f"-> [LOGIN SUCCESS] {user_name} ({user_id})")
        emit('auth_response', {
            'status': 'success',
            'action': 'login',
            'user_id': user_id,
            'user_name': user_name,
            'history': history
        })
    except Exception as e:
        print(f"-> [ERROR LOGIN]: {e}")
        emit('auth_response', {'status': 'error', 'message': 'Terjadi kesalahan sistem.'})
    finally:
        conn.close()

# ==========================================
# EVENT SOCKET.IO: STATUS ONLINE / OFFLINE
# ==========================================
@socketio.on('register_online_user')
def handle_register_online_user(user_id):
    if not user_id:
        return

    user_info = online_users.get(request.sid, {})
    user_info['user_id'] = user_id
    online_users[request.sid] = user_info

    join_room(user_id)
    emit('user_status_change', {'userId': user_id, 'status': 'online'}, broadcast=True)

@socketio.on('get_online_users')
def handle_get_online_users():
    emit('online_users_list', get_active_online_user_ids())

@socketio.on('verify_key')
def handle_verify_key(data):
    me = online_users.get(request.sid)
    if not me:
        emit('key_response', {'ok': False, 'message': 'Sesi tidak valid, silakan login ulang.'})
        return

    data = data or {}
    key_bin = data.get('key') or ''

    # Kunci yang dicek = kunci user yang login (dari sesi server),
    # bukan dari data client yang bisa dipalsukan
    owner_id = me['user_id']

    conn = get_db_connection()
    if not conn:
        emit('key_response', {'ok': False, 'message': 'Gagal terhubung ke database.'})
        return

    try:
        cursor = conn.cursor()
        cursor.execute("SELECT access_key FROM users WHERE user_id = %s LIMIT 1", (owner_id,))
        row = cursor.fetchone()

        db_key = row[0] if row else None
        if isinstance(db_key, (bytes, bytearray)):
            db_key = db_key.decode('utf-8', errors='ignore')

        if not row or not db_key:
            emit('key_response', {'ok': False, 'message': 'Akun belum punya kunci.'})
        elif db_key == key_bin:
            emit('key_response', {'ok': True})
        else:
            emit('key_response', {'ok': False, 'message': 'Kunci salah, pesan tidak bisa dibuka.'})
    except Exception as e:
        print(f"-> [ERROR VERIFY KEY]: {e}")
        emit('key_response', {'ok': False, 'message': 'Terjadi kesalahan sistem.'})
    finally:
        conn.close()

@socketio.on('disconnect')
def handle_disconnect(*args):
    user_data = online_users.pop(request.sid, None)
    if user_data and 'user_id' in user_data:
        user_id = user_data['user_id']
        still_online = any(u.get('user_id') == user_id for u in online_users.values())
        if not still_online:
            emit('user_status_change', {'userId': user_id, 'status': 'offline'}, broadcast=True)

# ==========================================
# EVENT SOCKET.IO: TRANSMISI CHAT
# ==========================================
@socketio.on('send_message')
def handle_send_message(data):
    sender = online_users.get(request.sid)
    if not sender:
        emit('message_error', {'message': 'Sesi tidak valid, silakan login ulang.'})
        return

    data = data or {}
    receiver_id = (data.get('receiver_id') or '').strip()
    binary_message = (data.get('message') or '').strip()

    if not receiver_id or not binary_message:
        emit('message_error', {'message': 'Pesan atau penerima tidak valid.'})
        return

    # Validasi format frame: kelipatan 10 bit, start 0, end 1
    if not FRAME_PATTERN.fullmatch(binary_message):
        emit('message_error', {'message': 'Format pesan tidak valid (kelipatan 10 bit, start 0, end 1).'})
        return

    conn = get_db_connection()
    if not conn:
        emit('message_error', {'message': 'Gagal terhubung ke database.'})
        return

    try:
        cursor = conn.cursor()
        cursor.execute("SELECT user_id FROM users WHERE user_id = %s LIMIT 1", (receiver_id,))
        row = cursor.fetchone()
        if not row:
            emit('message_error', {'message': f'ID "{receiver_id}" tidak ditemukan!'})
            return
        receiver_id = row[0]

        binary_bytes = binary_message.encode('utf-8')

        cursor.execute(
            """
            INSERT INTO messages (sender_id, sender_name, receiver_id, message, created_at)
            VALUES (%s, %s, %s, %s, NOW())
            """,
            (sender['user_id'], sender['user_name'], receiver_id, binary_bytes)
        )
        conn.commit()
        print(f"-> [SUCCESS] Pesan LONGBLOB ({len(binary_message)} bit) {sender['user_id']} -> {receiver_id} tersimpan di MySQL")
    except Exception as e:
        print(f"-> [ERROR DATABASE MESSAGES]: {e}")
        emit('message_error', {'message': 'Pesan gagal disimpan.'})
        return
    finally:
        conn.close()

    emit('receive_message', {
        'sender_id': sender['user_id'],
        'sender_name': sender['user_name'],
        'receiver_id': receiver_id,
        'message': binary_message,
        'time': data.get('time', '')
    }, to=receiver_id)

if __name__ == '__main__':
    socketio.run(app, debug=True, host='0.0.0.0', port=5000)