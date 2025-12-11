import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';

const {
  PORT = 3000,
  DATABASE_URL,
  API_KEY = ''
} = process.env;

if (!DATABASE_URL) {
  console.error('DATABASE_URL es requerido');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(cors());
app.use(express.json());

async function initTables() {
  const ddl = [
    `create table if not exists predio_logs (
      id serial primary key,
      id_predio text not null,
      status text check (status in ('rojo','azul','neutral')),
      seccion text,
      usuario text,
      created_at timestamptz default now()
    );`,
    `create table if not exists user_sessions (
      id serial primary key,
      usuario text not null,
      secciones text,
      created_at timestamptz default now()
    );`
  ];
  for (const q of ddl) {
    await pool.query(q);
  }
  console.log('Tablas verificadas');
}

function auth(req, res, next) {
  if (!API_KEY) return next();
  const header = req.headers.authorization || '';
  if (header === `Bearer ${API_KEY}`) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

app.get('/health', (req, res) => res.json({ ok: true }));

// GET /predios?secciones=356,357
app.get('/predios', auth, async (req, res) => {
  const secciones = (req.query.secciones || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  try {
    const query = secciones.length
      ? { text: 'select id_predio, status from predios where seccion = any($1)', values: [secciones] }
      : { text: 'select id_predio, status from predios', values: [] };
    const { rows } = await pool.query(query);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'db_error' });
  }
});

// POST /predios { id_predio, status, seccion?, usuario? }
app.post('/predios', auth, async (req, res) => {
  const { id_predio, status = 'neutral', seccion = null, usuario = null } = req.body || {};
  if (!id_predio) return res.status(400).json({ error: 'id_predio requerido' });
  if (!['rojo', 'azul', 'neutral'].includes(status)) return res.status(400).json({ error: 'status inválido' });
  try {
    await pool.query(
      `insert into predios (id_predio, status, seccion, updated_at)
       values ($1, $2, $3, now())
       on conflict (id_predio) do update set status = excluded.status, seccion = excluded.seccion, updated_at = now()`,
      [id_predio, status, seccion]
    );
    await pool.query(
      `insert into predio_logs (id_predio, status, seccion, usuario, created_at)
       values ($1, $2, $3, $4, now())`,
      [id_predio, status, seccion, usuario]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'db_error' });
  }
});

// POST /login { usuario, secciones? }
app.post('/login', auth, async (req, res) => {
  const { usuario, secciones = null } = req.body || {};
  if (!usuario) return res.status(400).json({ error: 'usuario requerido' });
  try {
    await pool.query(
      `insert into user_sessions (usuario, secciones, created_at) values ($1, $2, now())`,
      [usuario, secciones]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'db_error' });
  }
});

// GET /stats -> totales por seccion
app.get('/stats', auth, async (req, res) => {
  try {
    // Usa la seccion de predios; si es null, toma la última seccion registrada en logs
    const { rows } = await pool.query(`
      with base as (
        select
          p.id_predio,
          p.status,
          coalesce(
            p.seccion,
            (select seccion from predio_logs pl
             where pl.id_predio = p.id_predio and pl.seccion is not null
             order by pl.created_at desc limit 1)
          ) as seccion
        from predios p
      )
      select
        coalesce(seccion, '(sin seccion)') as seccion,
        count(*) filter (where status = 'rojo') as rojo,
        count(*) filter (where status = 'azul') as azul,
        count(*) filter (where status = 'neutral') as neutral,
        count(*) as total
      from base
      group by seccion
      order by seccion
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'db_error' });
  }
});

// GET /users -> usuarios y último acceso
app.get('/users', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      select
        usuario,
        max(created_at) as last_seen,
        string_agg(distinct secciones, ',') as secciones
      from user_sessions
      group by usuario
      order by last_seen desc
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'db_error' });
  }
});

// GET /activity?limit=100 -> últimos cambios
app.get('/activity', auth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
  try {
    const { rows } = await pool.query(
      `select id_predio, status, seccion, usuario, created_at
       from predio_logs
       order by created_at desc
       limit $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'db_error' });
  }
});

initTables()
  .then(() => {
    app.listen(PORT, () => console.log(`API escuchando en puerto ${PORT}`));
  })
  .catch(err => {
    console.error('Error al inicializar tablas', err);
    process.exit(1);
  });
