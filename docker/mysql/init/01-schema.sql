-- UniHub MySQL Database Schema
-- This script runs automatically on first container startup

-- Use the unihub database
USE unihub;

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255),
    avatar_url TEXT,
    role ENUM('user', 'admin') NOT NULL DEFAULT 'user',
    is_active BOOLEAN DEFAULT TRUE,
    email_verified BOOLEAN DEFAULT FALSE,
    timezone VARCHAR(64) NULL COMMENT 'IANA timezone e.g. Europe/Berlin; NULL = use device',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_users_email (email),
    INDEX idx_users_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- User sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    token VARCHAR(512) NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_sessions_token (token),
    INDEX idx_sessions_user (user_id),
    INDEX idx_sessions_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Contacts table
CREATE TABLE IF NOT EXISTS contacts (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100),
    email VARCHAR(255),
    email2 VARCHAR(255),
    email3 VARCHAR(255),
    phone VARCHAR(50),
    phone2 VARCHAR(50),
    phone3 VARCHAR(50),
    company VARCHAR(255),
    job_title VARCHAR(255),
    notes TEXT,
    avatar_url TEXT,
    is_favorite BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_contacts_user (user_id),
    INDEX idx_contacts_name (first_name, last_name),
    INDEX idx_contacts_email (email),
    INDEX idx_contacts_favorite (user_id, is_favorite)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Calendar events table
CREATE TABLE IF NOT EXISTS calendar_events (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    start_time DATETIME NOT NULL,
    end_time DATETIME NOT NULL,
    all_day BOOLEAN DEFAULT FALSE,
    location VARCHAR(500),
    color VARCHAR(20) DEFAULT '#22c55e',
    recurrence VARCHAR(100),
    reminder_minutes INT,
    reminders JSON DEFAULT NULL COMMENT 'Array of reminder minutes before event: [0, 15, 60] for default + 15min + 1hr before',
    todo_status VARCHAR(20) DEFAULT NULL COMMENT 'done, changed, time_moved, cancelled',
    is_todo_only BOOLEAN DEFAULT FALSE COMMENT 'True for standalone todos without calendar dates',
    done_at DATETIME NULL COMMENT 'Timestamp when task was marked as done',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_events_user (user_id),
    INDEX idx_events_start (start_time),
    INDEX idx_events_user_time (user_id, start_time, end_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Event subtasks table (shared by Calendar + ToDo views)
CREATE TABLE IF NOT EXISTS calendar_event_subtasks (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    event_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    title VARCHAR(255) NOT NULL,
    is_done BOOLEAN DEFAULT FALSE,
    position INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_subtasks_event (event_id),
    INDEX idx_subtasks_user (user_id),
    INDEX idx_subtasks_order (event_id, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Mail accounts table
CREATE TABLE IF NOT EXISTS mail_accounts (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    email_address VARCHAR(255) NOT NULL,
    display_name VARCHAR(255),
    provider VARCHAR(50) NOT NULL,
    imap_host VARCHAR(255),
    imap_port INT DEFAULT 993,
    smtp_host VARCHAR(255),
    smtp_port INT DEFAULT 587,
    -- Encrypted credentials
    encrypted_password TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    last_synced_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_mail_accounts_user (user_id),
    INDEX idx_mail_accounts_email (email_address),
    UNIQUE KEY unique_user_email (user_id, email_address)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Emails table
CREATE TABLE IF NOT EXISTS emails (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    mail_account_id CHAR(36) NOT NULL,
    message_id VARCHAR(500),
    subject TEXT,
    from_address VARCHAR(255) NOT NULL,
    from_name VARCHAR(255),
    to_addresses JSON NOT NULL,
    cc_addresses JSON,
    bcc_addresses JSON,
    body_text LONGTEXT,
    body_html LONGTEXT,
    folder VARCHAR(50) DEFAULT 'inbox',
    is_read BOOLEAN DEFAULT FALSE,
    is_starred BOOLEAN DEFAULT FALSE,
    is_draft BOOLEAN DEFAULT FALSE,
    has_attachments BOOLEAN DEFAULT FALSE,
    received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (mail_account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE,
    INDEX idx_emails_user (user_id),
    INDEX idx_emails_account (mail_account_id),
    INDEX idx_emails_folder (mail_account_id, folder),
    INDEX idx_emails_date (received_at DESC),
    INDEX idx_emails_unread (user_id, is_read, received_at DESC),
    FULLTEXT INDEX ft_emails_search (subject, body_text)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Email attachments table
CREATE TABLE IF NOT EXISTS email_attachments (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    email_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    content_type VARCHAR(100),
    size_bytes BIGINT,
    storage_path TEXT,
    content_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_attachments_email (email_id),
    INDEX idx_attachments_user (user_id),
    INDEX idx_attachments_content_id (content_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Admin bootstrap is now handled by API startup using:
-- BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD
