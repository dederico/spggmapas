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

// Caché para totales de predios por sección (se calcula una vez al inicio)
let totalesPrediosCache = null;

function calcularTotalesPorSeccion() {
  if (totalesPrediosCache) {
    return totalesPrediosCache;
  }

  try {
    const fs = require('fs');
    const path = require('path');
    const turf = require('@turf/turf');

    console.log('[calcularTotalesPorSeccion] Iniciando cálculo espacial...');

    // Leer archivo de secciones (polígonos del INE)
    const seccionesPath = path.join(__dirname, '../data/secciones_spgg.geojson');
    const secciones = JSON.parse(fs.readFileSync(seccionesPath, 'utf8'));

    // Leer archivo de predios (puntos)
    const prediosPath = path.join(__dirname, '../data/predios_wgs84.geojson');
    const predios = JSON.parse(fs.readFileSync(prediosPath, 'utf8'));

    const totalesPorSeccion = {};

    // Inicializar contador para cada sección
    for (const seccionFeature of secciones.features) {
      const seccionNum = String(seccionFeature.properties.SECCION);
      totalesPorSeccion[seccionNum] = 0;
    }

    // Contar predios en cada sección
    let procesados = 0;
    for (const predio of predios.features) {
      procesados++;
      if (procesados % 5000 === 0) {
        console.log(`[calcularTotalesPorSeccion] Procesados ${procesados}/${predios.features.length} predios...`);
      }

      let punto;
      if (predio.geometry.type === 'Point') {
        punto = predio;
      } else if (predio.geometry.type === 'Polygon' || predio.geometry.type === 'MultiPolygon') {
        punto = turf.centroid(predio);
      } else {
        continue;
      }

      // Buscar en qué sección cae este punto
      for (const seccionFeature of secciones.features) {
        try {
          if (turf.booleanPointInPolygon(punto, seccionFeature)) {
            const seccionNum = String(seccionFeature.properties.SECCION);
            totalesPorSeccion[seccionNum]++;
            break;
          }
        } catch (e) {
          continue;
        }
      }
    }

    console.log('[calcularTotalesPorSeccion] ✅ Cálculo completado');
    totalesPrediosCache = totalesPorSeccion;
    return totalesPorSeccion;
  } catch (err) {
    console.error('[calcularTotalesPorSeccion] ERROR:', err);
    throw err;
  }
}

// GET /secciones/totales -> obtener total de predios por sección (usa caché)
app.get('/secciones/totales', auth, async (req, res) => {
  try {
    const totalesPorSeccion = calcularTotalesPorSeccion();

    const resultado = Object.entries(totalesPorSeccion)
      .map(([seccion, total]) => ({ seccion, total_predios: total }))
      .sort((a, b) => {
        const numA = parseInt(a.seccion);
        const numB = parseInt(b.seccion);
        return numA - numB;
      });

    res.json(resultado);
  } catch (err) {
    console.error('[GET /secciones/totales] ERROR:', err);
    res.status(500).json({ error: 'spatial_intersection_error', message: err.message });
  }
});

// GET /secciones/progreso -> obtener predios trabajados por sección (SIN vueltas)
app.get('/secciones/progreso', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      select
        seccion,
        count(distinct id_predio) as predios_trabajados,
        count(distinct id_predio) filter (where status = 'rojo') as total_rojos,
        count(distinct id_predio) filter (where status = 'azul') as total_azules,
        count(distinct id_predio) filter (where status = 'neutral') as total_neutrales
      from predios
      where seccion is not null
      group by seccion
      order by seccion
    `);
    res.json(rows);
  } catch (err) {
    console.error('[GET /secciones/progreso] ERROR:', err);
    res.status(500).json({ error: 'db_error' });
  }
});

// GET /secciones/resumen -> combina totales y progreso con porcentajes (SIN vueltas)
app.get('/secciones/resumen', auth, async (req, res) => {
  try {
    // Obtener totales desde caché
    const totalesPorSeccion = calcularTotalesPorSeccion();

    // Obtener progreso de la BD
    const { rows } = await pool.query(`
      select
        seccion,
        count(distinct id_predio) as predios_trabajados,
        count(distinct id_predio) filter (where status = 'rojo') as total_rojos,
        count(distinct id_predio) filter (where status = 'azul') as total_azules,
        count(distinct id_predio) filter (where status = 'neutral') as total_neutrales
      from predios
      where seccion is not null
      group by seccion
      order by seccion
    `);

    // Combinar datos
    const resumen = [];
    const seccionesConDatos = new Set(rows.map(r => r.seccion));

    // Agregar secciones con trabajo
    for (const row of rows) {
      const total = totalesPorSeccion[row.seccion] || 0;
      const trabajados = parseInt(row.predios_trabajados) || 0;
      const porcentaje = total > 0 ? ((trabajados / total) * 100).toFixed(2) : 0;

      resumen.push({
        seccion: row.seccion,
        total_predios: total,
        predios_trabajados: trabajados,
        porcentaje_avance: parseFloat(porcentaje),
        total_rojos: parseInt(row.total_rojos) || 0,
        total_azules: parseInt(row.total_azules) || 0,
        total_neutrales: parseInt(row.total_neutrales) || 0
      });
    }

    // Agregar secciones sin trabajo (356-417)
    for (let i = 356; i <= 417; i++) {
      const seccion = String(i);
      if (!seccionesConDatos.has(seccion) && totalesPorSeccion[seccion]) {
        resumen.push({
          seccion,
          total_predios: totalesPorSeccion[seccion],
          predios_trabajados: 0,
          porcentaje_avance: 0,
          total_rojos: 0,
          total_azules: 0,
          total_neutrales: 0
        });
      }
    }

    // Ordenar por número de sección
    resumen.sort((a, b) => parseInt(a.seccion) - parseInt(b.seccion));

    res.json(resumen);
  } catch (err) {
    console.error('[GET /secciones/resumen] ERROR:', err);
    res.status(500).json({ error: 'error al generar resumen' });
  }
});

initTables()
  .then(() => {
    // Pre-calcular totales de predios por sección al iniciar
    console.log('🔄 Pre-calculando totales de predios por sección...');
    try {
      calcularTotalesPorSeccion();
      console.log('✅ Totales pre-calculados correctamente');
    } catch (err) {
      console.error('⚠️  Error al pre-calcular totales (el cálculo se hará en el primer request):', err.message);
    }

    app.listen(PORT, () => console.log(`API escuchando en puerto ${PORT}`));
  })
  .catch(err => {
    console.error('Error al inicializar tablas', err);
    process.exit(1);
  });
