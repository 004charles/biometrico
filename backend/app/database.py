import sqlite3
import os

DB_PATH = os.environ.get("DB_PATH", os.path.join(os.path.dirname(os.path.dirname(__file__)), "attendance.db"))

def get_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()

def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # Tabela de Funcionários
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        department TEXT NOT NULL,
        role TEXT NOT NULL,
        work_start_time TEXT DEFAULT '08:00', -- Horário oficial de entrada da empresa
        tolerance_minutes INTEGER DEFAULT 10,  -- Tolerância de atraso (ex: 10 min)
        photo_path TEXT,
        face_features BLOB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # Tabela de Presenças (Ponto)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        type TEXT NOT NULL, -- CHECK_IN, CHECK_OUT
        fingerprint_verified INTEGER NOT NULL,
        delay_minutes INTEGER DEFAULT 0, -- Minutos de atraso calculados
        is_late INTEGER DEFAULT 0,        -- 1 se atrasado, 0 se no horário
        device_info TEXT,
        status TEXT NOT NULL, -- APPROVED, REJECTED
        FOREIGN KEY (employee_id) REFERENCES employees (id)
    );
    """)

    # Migrações caso colunas não existam em banco prévio
    try:
        cursor.execute("ALTER TABLE employees ADD COLUMN work_start_time TEXT DEFAULT '08:00'")
    except Exception:
        pass

    try:
        cursor.execute("ALTER TABLE employees ADD COLUMN tolerance_minutes INTEGER DEFAULT 10")
    except Exception:
        pass

    try:
        cursor.execute("ALTER TABLE attendance ADD COLUMN delay_minutes INTEGER DEFAULT 0")
    except Exception:
        pass

    try:
        cursor.execute("ALTER TABLE attendance ADD COLUMN is_late INTEGER DEFAULT 0")
    except Exception:
        pass

    try:
        cursor.execute("ALTER TABLE employees ADD COLUMN biometric_code TEXT")
    except Exception:
        pass

    try:
        cursor.execute("ALTER TABLE employees ADD COLUMN has_fingerprint INTEGER DEFAULT 0")
    except Exception:
        pass

    try:
        cursor.execute("ALTER TABLE employees ADD COLUMN humancore_id INTEGER")
    except Exception:
        pass

    # Fila de envio ao Humancore.
    # As batidas que já existiam antes da fila foram enviadas em tempo real pelo código
    # antigo, por isso ficam como 'SENT' (reenviá-las criaria duplicados no Humancore).
    # As novas batidas são gravadas explicitamente como 'PENDING'.
    for ddl in (
        "ALTER TABLE attendance ADD COLUMN sync_status TEXT DEFAULT 'SENT'",
        "ALTER TABLE attendance ADD COLUMN sync_attempts INTEGER DEFAULT 0",
        "ALTER TABLE attendance ADD COLUMN sync_error TEXT",
        "ALTER TABLE attendance ADD COLUMN sync_next_try TEXT",
        "ALTER TABLE attendance ADD COLUMN synced_at TEXT",
    ):
        try:
            cursor.execute(ddl)
        except Exception:
            pass
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_attendance_sync ON attendance (sync_status)")
    # Filtros por dia/mês/intervalo na dashboard e nos relatórios
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_attendance_timestamp ON attendance (timestamp)")

    # Reconhecimento facial: foto e semelhança de cada batida
    for ddl in (
        "ALTER TABLE attendance ADD COLUMN face_verified INTEGER DEFAULT 0",
        "ALTER TABLE attendance ADD COLUMN face_similarity REAL",
        "ALTER TABLE attendance ADD COLUMN photo_path TEXT",
    ):
        try:
            cursor.execute(ddl)
        except Exception:
            pass

    conn.commit()
    conn.close()
