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

// Configuración CORS mejorada
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());

async function initTables() {
  const ddl = [
    `create table if not exists predios (
      id_predio text primary key,
      status text check (status in ('rojo','azul','neutral')) default 'neutral',
      seccion text,
      vuelta_actual int default 0,
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
    `create table if not exists reset_audit (
      id serial primary key,
      usuario text,
      mode text,
      seccion text,
      affected_count int,
      created_at timestamptz default now()
    );`,
    `create table if not exists visitas (
      id serial primary key,
      id_predio text not null,
      vuelta int not null check (vuelta >= 1),
      resultado text,
      seccion text,
      usuario text,
      created_at timestamptz default now()
    );`,
    `create table if not exists vuelta_2_demograficos (
      id serial primary key,
      id_predio text not null,
      total_personas int,
      menores int,
      mayores int,
      seccion text,
      usuario text,
      created_at timestamptz default now()
    );`,
    `create table if not exists personas (
      id serial primary key,
      id_predio text not null,
      nombre text not null,
      es_menor boolean default false,
      seccion text,
      usuario text,
      created_at timestamptz default now()
    );`,
    `create table if not exists vuelta_3_apoyo (
      id serial primary key,
      id_predio text not null,
      tipos_apoyo text[] not null,
      seccion text,
      usuario text,
      created_at timestamptz default now()
    );`,
    `create index if not exists idx_logs_created on predio_logs(created_at);`,
    `create index if not exists idx_logs_seccion on predio_logs(seccion);`,
    `create index if not exists idx_logs_status on predio_logs(status);`,
    `create index if not exists idx_visitas_predio on visitas(id_predio);`,
    `create index if not exists idx_visitas_vuelta on visitas(vuelta);`,
    `create index if not exists idx_demograficos_predio on vuelta_2_demograficos(id_predio);`,
    `create index if not exists idx_personas_predio on personas(id_predio);`,
    `create index if not exists idx_apoyo_predio on vuelta_3_apoyo(id_predio);`
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
      ? { text: 'select id_predio, status, vuelta_actual from predios where seccion = any($1)', values: [secciones] }
      : { text: 'select id_predio, status, vuelta_actual from predios', values: [] };
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
    console.log(`[POST /predios] Usuario: ${usuario}, Predio: ${id_predio}, Status: ${status}, Seccion: ${seccion}`);
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
    console.log(`[POST /predios] ✓ Guardado exitoso: ${id_predio}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /predios] ERROR:', err);
    res.status(500).json({ error: 'db_error' });
  }
});

// POST /login { usuario, secciones? }
app.post('/login', auth, async (req, res) => {
  const { usuario, secciones = null } = req.body || {};
  if (!usuario) return res.status(400).json({ error: 'usuario requerido' });
  try {
    console.log(`[POST /login] Usuario: ${usuario}, Secciones: ${secciones || 'todas'}`);
    await pool.query(
      `insert into user_sessions (usuario, secciones, created_at) values ($1, $2, now())`,
      [usuario, secciones]
    );
    console.log(`[POST /login] ✓ Login registrado: ${usuario}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /login] ERROR:', err);
    res.status(500).json({ error: 'db_error' });
  }
});

// GET /predios/:id/progreso -> obtener progreso completo de un predio
app.get('/predios/:id/progreso', auth, async (req, res) => {
  const { id } = req.params;
  try {
    // Obtener vuelta actual
    const { rows: predioRows } = await pool.query(
      'select vuelta_actual, status from predios where id_predio = $1',
      [id]
    );
    const vuelta_actual = predioRows.length > 0 ? predioRows[0].vuelta_actual : 0;
    const status = predioRows.length > 0 ? predioRows[0].status : 'neutral';

    // Obtener datos de vuelta 2 si existen
    const { rows: vuelta2Rows } = await pool.query(
      'select total_personas, menores, mayores from vuelta_2_demograficos where id_predio = $1 order by created_at desc limit 1',
      [id]
    );
    const vuelta2 = vuelta2Rows.length > 0 ? vuelta2Rows[0] : null;

    // Obtener nombres si existen
    const { rows: personasRows } = await pool.query(
      'select nombre, es_menor from personas where id_predio = $1',
      [id]
    );

    // Obtener datos de vuelta 3 si existen
    const { rows: vuelta3Rows } = await pool.query(
      'select tipos_apoyo from vuelta_3_apoyo where id_predio = $1 order by created_at desc limit 1',
      [id]
    );
    const vuelta3 = vuelta3Rows.length > 0 ? vuelta3Rows[0] : null;

    res.json({
      id_predio: id,
      vuelta_actual,
      status,
      vuelta_2: vuelta2,
      personas: personasRows,
      vuelta_3: vuelta3
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'db_error' });
  }
});

// POST /vuelta-1 { id_predio, resultado, seccion?, usuario? }
app.post('/vuelta-1', auth, async (req, res) => {
  const { id_predio, resultado, seccion = null, usuario = null } = req.body || {};
  if (!id_predio) return res.status(400).json({ error: 'id_predio requerido' });
  if (!['azul', 'rojo', 'neutral'].includes(resultado)) {
    return res.status(400).json({ error: 'resultado inválido' });
  }

  try {
    console.log(`[POST /vuelta-1] Usuario: ${usuario}, Predio: ${id_predio}, Resultado: ${resultado}`);

    // Actualizar predios con status y vuelta_actual = 1
    await pool.query(
      `insert into predios (id_predio, status, seccion, vuelta_actual, updated_at)
       values ($1, $2, $3, 1, now())
       on conflict (id_predio) do update
       set status = excluded.status, seccion = excluded.seccion, vuelta_actual = 1, updated_at = now()`,
      [id_predio, resultado, seccion]
    );

    // Registrar en visitas
    await pool.query(
      `insert into visitas (id_predio, vuelta, resultado, seccion, usuario, created_at)
       values ($1, 1, $2, $3, $4, now())`,
      [id_predio, resultado, seccion, usuario]
    );

    // Mantener compatibilidad con predio_logs
    await pool.query(
      `insert into predio_logs (id_predio, status, seccion, usuario, created_at)
       values ($1, $2, $3, $4, now())`,
      [id_predio, resultado, seccion, usuario]
    );

    console.log(`[POST /vuelta-1] ✓ Vuelta 1 guardada: ${id_predio}`);
    res.json({ ok: true, vuelta_actual: 1 });
  } catch (err) {
    console.error('[POST /vuelta-1] ERROR:', err);
    res.status(500).json({ error: 'db_error' });
  }
});

// POST /vuelta-2 { id_predio, total_personas, menores, mayores, personas: [{nombre, es_menor}], seccion?, usuario? }
app.post('/vuelta-2', auth, async (req, res) => {
  const { id_predio, total_personas, menores, mayores, personas = [], seccion = null, usuario = null } = req.body || {};
  if (!id_predio) return res.status(400).json({ error: 'id_predio requerido' });

  try {
    console.log(`[POST /vuelta-2] Usuario: ${usuario}, Predio: ${id_predio}, Personas: ${total_personas}`);

    // Actualizar vuelta_actual = 2
    await pool.query(
      `insert into predios (id_predio, seccion, vuelta_actual, updated_at)
       values ($1, $2, 2, now())
       on conflict (id_predio) do update
       set vuelta_actual = 2, updated_at = now()`,
      [id_predio, seccion]
    );

    // Guardar datos demográficos
    await pool.query(
      `insert into vuelta_2_demograficos (id_predio, total_personas, menores, mayores, seccion, usuario, created_at)
       values ($1, $2, $3, $4, $5, $6, now())`,
      [id_predio, total_personas, menores, mayores, seccion, usuario]
    );

    // Guardar nombres de personas
    for (const persona of personas) {
      await pool.query(
        `insert into personas (id_predio, nombre, es_menor, seccion, usuario, created_at)
         values ($1, $2, $3, $4, $5, now())`,
        [id_predio, persona.nombre, persona.es_menor || false, seccion, usuario]
      );
    }

    // Registrar en visitas
    await pool.query(
      `insert into visitas (id_predio, vuelta, resultado, seccion, usuario, created_at)
       values ($1, 2, 'completado', $2, $3, now())`,
      [id_predio, seccion, usuario]
    );

    console.log(`[POST /vuelta-2] ✓ Vuelta 2 guardada: ${id_predio} - ${personas.length} personas`);
    res.json({ ok: true, vuelta_actual: 2 });
  } catch (err) {
    console.error('[POST /vuelta-2] ERROR:', err);
    res.status(500).json({ error: 'db_error' });
  }
});

// POST /vuelta-3 { id_predio, tipos_apoyo: [], seccion?, usuario? }
app.post('/vuelta-3', auth, async (req, res) => {
  const { id_predio, tipos_apoyo = [], seccion = null, usuario = null } = req.body || {};
  if (!id_predio) return res.status(400).json({ error: 'id_predio requerido' });
  if (!Array.isArray(tipos_apoyo) || tipos_apoyo.length === 0) {
    return res.status(400).json({ error: 'tipos_apoyo debe ser un array no vacío' });
  }

  const tiposValidos = ['LONA', 'BARDA', 'CASILLA', 'MANZANERO', 'PROMOTOR DE REDES'];
  const todosValidos = tipos_apoyo.every(t => tiposValidos.includes(t));
  if (!todosValidos) {
    return res.status(400).json({ error: 'tipos_apoyo contiene valores inválidos' });
  }

  try {
    console.log(`[POST /vuelta-3] Usuario: ${usuario}, Predio: ${id_predio}, Apoyos: ${tipos_apoyo.join(', ')}`);

    // Actualizar vuelta_actual = 3
    await pool.query(
      `insert into predios (id_predio, seccion, vuelta_actual, updated_at)
       values ($1, $2, 3, now())
       on conflict (id_predio) do update
       set vuelta_actual = 3, updated_at = now()`,
      [id_predio, seccion]
    );

    // Guardar tipos de apoyo
    await pool.query(
      `insert into vuelta_3_apoyo (id_predio, tipos_apoyo, seccion, usuario, created_at)
       values ($1, $2, $3, $4, now())`,
      [id_predio, tipos_apoyo, seccion, usuario]
    );

    // Registrar en visitas
    await pool.query(
      `insert into visitas (id_predio, vuelta, resultado, seccion, usuario, created_at)
       values ($1, 3, 'completado', $2, $3, now())`,
      [id_predio, seccion, usuario]
    );

    console.log(`[POST /vuelta-3] ✓ Vuelta 3 guardada: ${id_predio}`);
    res.json({ ok: true, vuelta_actual: 3 });
  } catch (err) {
    console.error('[POST /vuelta-3] ERROR:', err);
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
// Body: { usuario: 'nombre_usuario' } (opcional, para auditoría)
app.post('/admin/reset', auth, async (req, res) => {
  const mode = req.query.mode || 'soft'; // soft = resetear a neutral, hard = eliminar
  const seccion = req.query.seccion || null;
  const usuario = req.body?.usuario || 'unknown';

  console.log(`[POST /admin/reset] ⚠️  RESET INICIADO - Usuario: ${usuario}, Mode: ${mode}, Seccion: ${seccion || 'todas'}`);

  try {
    let affectedCount = 0;

    if (mode === 'hard') {
      // Eliminar predios completamente
      if (seccion) {
        const result = await pool.query('delete from predios where seccion = $1 returning id_predio', [seccion]);
        affectedCount = result.rowCount;
      } else {
        const result = await pool.query('delete from predios returning id_predio');
        affectedCount = result.rowCount;
      }
      console.log(`[POST /admin/reset] 🗑️  ELIMINACIÓN COMPLETADA - ${affectedCount} predios eliminados`);
    } else {
      // Resetear a neutral (modo suave)
      if (seccion) {
        const result = await pool.query(
          `update predios set status = 'neutral', updated_at = now() where seccion = $1 returning id_predio`,
          [seccion]
        );
        affectedCount = result.rowCount;
      } else {
        const result = await pool.query(`update predios set status = 'neutral', updated_at = now() returning id_predio`);
        affectedCount = result.rowCount;
      }
      console.log(`[POST /admin/reset] 🔄 RESET COMPLETADO - ${affectedCount} predios reseteados a neutral`);
    }

    // Registrar auditoría
    await pool.query(
      `insert into reset_audit (usuario, mode, seccion, affected_count, created_at)
       values ($1, $2, $3, $4, now())`,
      [usuario, mode, seccion, affectedCount]
    );
    console.log(`[POST /admin/reset] ✓ Auditoría registrada`);

    res.json({
      ok: true,
      mode,
      seccion,
      affected_count: affectedCount,
      message: mode === 'hard' ? 'Predios eliminados' : 'Predios reseteados a neutral'
    });
  } catch (err) {
    console.error('[POST /admin/reset] ❌ ERROR:', err);
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

// POST /admin/restore -> restaura estados desde predio_logs
// ?seccion=362 (requerido: sección a restaurar)
// Body: { usuario: 'nombre_usuario' } (opcional, para auditoría)
app.post('/admin/restore', auth, async (req, res) => {
  const seccion = req.query.seccion;
  const usuario = req.body?.usuario || 'unknown';

  if (!seccion) {
    return res.status(400).json({ error: 'seccion es requerida' });
  }

  console.log(`[POST /admin/restore] ♻️  RESTAURACIÓN INICIADA - Usuario: ${usuario}, Seccion: ${seccion}`);

  try {
    // Buscar el último estado de cada predio en predio_logs para esta sección
    const { rows } = await pool.query(`
      with latest_logs as (
        select distinct on (id_predio)
          id_predio,
          status,
          seccion
        from predio_logs
        where seccion = $1
        order by id_predio, created_at desc
      )
      select * from latest_logs
    `, [seccion]);

    console.log(`[POST /admin/restore] 📋 Encontrados ${rows.length} predios en logs para restaurar`);

    if (rows.length === 0) {
      console.log(`[POST /admin/restore] ⚠️  No hay logs para restaurar en sección ${seccion}`);
      return res.json({ ok: true, restored_count: 0, message: 'No hay logs para restaurar' });
    }

    // Actualizar o insertar cada predio con su último estado conocido
    let restoredCount = 0;
    for (const row of rows) {
      await pool.query(
        `insert into predios (id_predio, status, seccion, updated_at)
         values ($1, $2, $3, now())
         on conflict (id_predio) do update
         set status = excluded.status, seccion = excluded.seccion, updated_at = now()`,
        [row.id_predio, row.status, row.seccion]
      );
      restoredCount++;
    }

    console.log(`[POST /admin/restore] ✓ RESTAURACIÓN COMPLETADA - ${restoredCount} predios restaurados`);

    // Registrar en auditoría
    await pool.query(
      `insert into reset_audit (usuario, mode, seccion, affected_count, created_at)
       values ($1, $2, $3, $4, now())`,
      [usuario, 'restore', seccion, restoredCount]
    );
    console.log(`[POST /admin/restore] ✓ Auditoría registrada`);

    res.json({
      ok: true,
      seccion,
      restored_count: restoredCount,
      message: `${restoredCount} predios restaurados desde logs`
    });
  } catch (err) {
    console.error('[POST /admin/restore] ❌ ERROR:', err);
    res.status(500).json({ error: 'db_error' });
  }
});

// GET /admin/reset-audit -> ver historial de resets y restauraciones
app.get('/admin/reset-audit', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      select * from reset_audit
      order by created_at desc
      limit 100
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
