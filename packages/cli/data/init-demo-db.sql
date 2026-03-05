-- Create the demo analytics database alongside the Atlas internal DB.
-- Runs as superuser during postgres container initialization (mounted as 00-init.sql).
-- demo.sql is mounted at /data/demo.sql (outside docker-entrypoint-initdb.d
-- to prevent Docker from also running it against the default 'atlas' database).
CREATE DATABASE atlas_demo;
GRANT ALL PRIVILEGES ON DATABASE atlas_demo TO atlas;
\connect atlas_demo;
\i /data/demo.sql
