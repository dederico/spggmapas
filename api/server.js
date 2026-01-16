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
    `create table if not exists predios (
      id_predio text primary key,
      status text check (status in ('rojo','azul','neutral')) default 'neutral',
      seccion text,
      updated_at timestamptz default now()
    );`,
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
    );`,
    `create index if not exists idx_logs_created on predio_logs(created_at);`,
    `create index if not exists idx_logs_seccion on predio_logs(seccion);`,
    `create index if not exists idx_logs_status on predio_logs(status);`
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

// POST /admin/reset -> limpia la base de datos (resetea predios a neutral o elimina)
// Opciones: ?mode=soft (resetea a neutral) o ?mode=hard (elimina registros)
// ?seccion=356 (opcional: limpia solo esa sección)
app.post('/admin/reset', auth, async (req, res) => {
  const mode = req.query.mode || 'soft'; // soft = resetear a neutral, hard = eliminar
  const seccion = req.query.seccion || null;

  try {
    if (mode === 'hard') {
      // Eliminar predios completamente
      if (seccion) {
        await pool.query('delete from predios where seccion = $1', [seccion]);
      } else {
        await pool.query('delete from predios');
      }
      res.json({ ok: true, mode: 'hard', seccion, message: 'Predios eliminados' });
    } else {
      // Resetear a neutral (modo suave)
      if (seccion) {
        await pool.query(
          `update predios set status = 'neutral', updated_at = now() where seccion = $1`,
          [seccion]
        );
      } else {
        await pool.query(`update predios set status = 'neutral', updated_at = now()`);
      }
      res.json({ ok: true, mode: 'soft', seccion, message: 'Predios reseteados a neutral' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'db_error' });
  }
});

// GET /analytics?month=2026-01&seccion=356&status=rojo -> análisis filtrado
app.get('/analytics', auth, async (req, res) => {
  const { month, seccion, status } = req.query;

  try {
    let query = `
      select
        date_trunc('month', created_at) as mes,
        seccion,
        status,
        usuario,
        count(*) as total
      from predio_logs
      where 1=1
    `;
    const params = [];
    let paramIndex = 1;

    // Filtro por mes (formato: YYYY-MM o YYYY-MM-DD)
    if (month) {
      const [year, monthNum] = month.split('-');
      if (year && monthNum) {
        query += ` and extract(year from created_at) = $${paramIndex}`;
        params.push(parseInt(year, 10));
        paramIndex++;
        query += ` and extract(month from created_at) = $${paramIndex}`;
        params.push(parseInt(monthNum, 10));
        paramIndex++;
      }
    }

    // Filtro por sección
    if (seccion) {
      query += ` and seccion = $${paramIndex}`;
      params.push(seccion);
      paramIndex++;
    }

    // Filtro por status
    if (status && ['rojo', 'azul', 'neutral'].includes(status)) {
      query += ` and status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    query += `
      group by mes, seccion, status, usuario
      order by mes desc, seccion, status
    `;

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'db_error' });
  }
});

// GET /analytics/summary -> resumen general por mes y sección
app.get('/analytics/summary', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      select
        date_trunc('month', created_at) as mes,
        seccion,
        count(*) filter (where status = 'rojo') as total_rojos,
        count(*) filter (where status = 'azul') as total_azules,
        count(*) filter (where status = 'neutral') as total_neutrales,
        count(distinct usuario) as usuarios_activos,
        count(*) as cambios_totales
      from predio_logs
      group by mes, seccion
      order by mes desc, seccion
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'db_error' });
  }
});

// GET /analytics/most-active -> seccionales más activos (más logins)
app.get('/analytics/most-active', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      select
        usuario,
        secciones,
        count(*) as total_logins,
        max(created_at) as ultimo_acceso,
        min(created_at) as primer_acceso
      from user_sessions
      where usuario != 'admin'
      group by usuario, secciones
      order by total_logins desc
      limit 20
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'db_error' });
  }
});

// GET /analytics/inactive -> seccionales que no han entrado
app.get('/analytics/inactive', auth, async (req, res) => {
  try {
    // Generar lista de secciones 356-417
    const allSecciones = [];
    for (let i = 356; i <= 417; i++) {
      allSecciones.push(`sec${i}`);
    }

    // Obtener usuarios que han entrado
    const { rows: activeUsers } = await pool.query(`
      select distinct usuario from user_sessions where usuario != 'admin'
    `);
    const activeSet = new Set(activeUsers.map(r => r.usuario));

    // Encontrar inactivos
    const inactive = allSecciones.filter(sec => !activeSet.has(sec));

    res.json({
      total_secciones: allSecciones.length,
      activas: activeSet.size,
      inactivas: inactive.length,
      lista_inactivas: inactive
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'db_error' });
  }
});

// GET /analytics/color-balance -> balance de rojos vs azules por seccional
app.get('/analytics/color-balance', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      select
        usuario,
        count(*) filter (where status = 'rojo') as total_rojos,
        count(*) filter (where status = 'azul') as total_azules,
        count(*) filter (where status = 'neutral') as total_neutrales,
        count(*) as total_cambios,
        case
          when count(*) filter (where status = 'rojo') > count(*) filter (where status = 'azul') then 'mas_rojos'
          when count(*) filter (where status = 'azul') > count(*) filter (where status = 'rojo') then 'mas_azules'
          else 'empate'
        end as balance
      from predio_logs
      where usuario is not null and usuario != 'admin'
      group by usuario
      having count(*) > 0
      order by total_cambios desc
    `);
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
