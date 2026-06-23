CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS tours (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  title TEXT NOT NULL,
  address TEXT,
  description TEXT,
  cover_image TEXT,
  index_url TEXT NOT NULL,
  asset_base_url TEXT NOT NULL,
  published_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (slug, revision_id),
  CHECK (status IN ('draft', 'published', 'archived'))
);

CREATE TABLE IF NOT EXISTS user_tours (
  user_id TEXT NOT NULL,
  tour_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, tour_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (tour_id) REFERENCES tours(id) ON DELETE CASCADE,
  CHECK (role IN ('viewer', 'manager', 'owner'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_tours_status ON tours(status, published_at);
CREATE INDEX IF NOT EXISTS idx_user_tours_user_id ON user_tours(user_id);
CREATE INDEX IF NOT EXISTS idx_user_tours_tour_id ON user_tours(tour_id);
