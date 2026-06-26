CREATE DOMAIN PlayerName AS VARCHAR(255);
  -- CHECK (VALUE ~ '^[a-zA-Z0-9_-]{3,20}$');

CREATE TABLE Players (
  id        INT PRIMARY KEY,
  name      PlayerName UNIQUE
);

CREATE TYPE EventType as ENUM (
  'League',
  'Preliminary',
  'Challenge',
  'Showcase',
  'Qualifier'
);

DO $$
DECLARE
  format_name TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'formattype'
  ) THEN
    EXECUTE format(
      'CREATE TYPE FormatType AS ENUM (%s)',
      (
        SELECT string_agg(quote_literal(value), ', ')
        FROM format_type_constants() AS formats(value)
      )
    );
  END IF;

  FOR format_name IN
    SELECT value
    FROM format_type_constants() AS formats(value)
  LOOP
    EXECUTE format('ALTER TYPE FormatType ADD VALUE IF NOT EXISTS %L', format_name);
  END LOOP;
END
$$;

CREATE TABLE Events (
  id        INT PRIMARY KEY,
  name      VARCHAR(255) NOT NULL,
  date      DATE NOT NULL,
  format    FormatType NOT NULL,
  kind      EventType NOT NULL,
  rounds    INT CHECK (rounds >= 3),
  players   INT CHECK (players >= 4)
);

CREATE DOMAIN Percentage AS FLOAT
  CHECK (VALUE >= 0 AND VALUE <= 100);

CREATE DOMAIN RecordType AS VARCHAR(8)
  CHECK (VALUE ~ '^[0-9]+-[0-9]+-[0-9]+$');

CREATE TABLE Standings (
  event_id  INT
    REFERENCES Events (id)
      ON UPDATE CASCADE
      ON DELETE CASCADE,
  rank      INT NOT NULL,
  player    PlayerName
    REFERENCES Players (name)
      ON UPDATE CASCADE
      ON DELETE CASCADE,
  record    RecordType NOT NULL,
  points    INT,
  omwp      Percentage,
  gwp       Percentage,
  owp       Percentage,

  PRIMARY KEY (event_id, player),
  UNIQUE(event_id, rank)
);

CREATE TYPE ResultType AS ENUM ('win', 'loss', 'draw');
CREATE TYPE GameResult AS (id INT, result ResultType);

CREATE TABLE Matches (
  id        INT NULL,
  event_id  INT
    REFERENCES Events (id)
      ON UPDATE CASCADE
      ON DELETE CASCADE,
  round     INT NOT NULL,
  player    PlayerName
    REFERENCES Players (name)
      ON UPDATE CASCADE
      ON DELETE CASCADE,
  opponent  PlayerName NULL
    REFERENCES Players (name)
      ON UPDATE CASCADE
      ON DELETE CASCADE,
  record    RecordType NOT NULL,
  result    ResultType NOT NULL,
  isBye     BOOLEAN DEFAULT FALSE,
  games     GameResult[] DEFAULT ARRAY[]::GameResult[],

  PRIMARY KEY (event_id, round, player)
);

CREATE TYPE CardQuantityPair AS (id INT, name TEXT, quantity INT);

CREATE TABLE Decks (
  id        INT PRIMARY KEY,
  event_id  INT
    REFERENCES Events (id)
      ON UPDATE CASCADE
      ON DELETE CASCADE,
  player    PlayerName
    REFERENCES Players (name)
      ON UPDATE CASCADE
      ON DELETE CASCADE,
  mainboard CardQuantityPair[] DEFAULT ARRAY[]::CardQuantityPair[],
  sideboard CardQuantityPair[] DEFAULT ARRAY[]::CardQuantityPair[]
);

CREATE TABLE Archetypes (
  id        INT PRIMARY KEY,
  deck_id   INT UNIQUE
    REFERENCES Decks (id)
      ON UPDATE CASCADE
      ON DELETE CASCADE,
  name      TEXT NOT NULL,
  archetype TEXT NULL,
  archetype_id INT NULL
);
