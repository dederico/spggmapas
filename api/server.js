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

// POST /predios { id_predio, status, seccion? }
app.post('/predios', auth, async (req, res) => {
  const { id_predio, status = 'neutral', seccion = null } = req.body || {};
  if (!id_predio) return res.status(400).json({ error: 'id_predio requerido' });
  if (!['rojo', 'azul', 'neutral'].includes(status)) return res.status(400).json({ error: 'status inválido' });
  try {
    await pool.query(
      `insert into predios (id_predio, status, seccion, updated_at)
       values ($1, $2, $3, now())
       on conflict (id_predio) do update set status = excluded.status, seccion = excluded.seccion, updated_at = now()`,
      [id_predio, status, seccion]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'db_error' });
  }
});

app.listen(PORT, () => console.log(`API escuchando en puerto ${PORT}`));
