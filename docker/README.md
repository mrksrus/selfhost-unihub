# UniHub - Docker Configuration for Self-Hosting

This directory contains Docker configuration files for self-hosting UniHub with MySQL.

## Quick Start

1. Copy the environment file and configure it:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` with your settings:
   - Set strong passwords for MySQL and the app
   - Configure your domain and ports

3. Start the services:
   ```bash
   docker-compose up -d
   ```

4. Access UniHub at `http://localhost:3000` (or your configured port)

## Services

- **unihub-app**: The main UniHub application (Node.js/Nginx)
- **unihub-mysql**: MySQL 8.0 database server
- **unihub-api**: Backend API service (optional, for email sync)

## Database Migrations

On first startup, the MySQL container will automatically run the initialization scripts in `docker/mysql/init/`.

## Backup

To backup your MySQL data:
```bash
docker exec unihub-mysql mysqldump -u root -p unihub > backup.sql
```

## SSL/HTTPS

For production, we recommend using a reverse proxy like Nginx or Traefik with Let's Encrypt certificates.

## Updating

```bash
docker-compose pull
docker-compose up -d
```
