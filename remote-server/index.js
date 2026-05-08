import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const pendingDevices = new Map(); // device_code → data

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// GET /api/mcp-info
app.get('/api/mcp-info', (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Supabase config not set' });
  }
  res.json({
    supabaseUrl: SUPABASE_URL,
    supabasePublishableKey: SUPABASE_ANON_KEY
  });
});

// POST /device/start
app.post('/device/start', (req, res) => {
  const { client_id, device_name, device_id } = req.body;

  const deviceCode = crypto.randomBytes(16).toString('hex');
  const userCode = crypto.randomBytes(4).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');

  const verificationUri = `https://mcp.zkarmor.com/device/verify`;
  const verificationUriComplete = `${verificationUri}?user_code=${userCode}`;

  const data = {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: verificationUriComplete,
    expires_in: 900,
    interval: 5
  };

  pendingDevices.set(deviceCode, {
    ...data,
    authorized: false,
    device_name,
    device_id: device_id || null
  });

  console.log(`[DEVICE START] Device code generado: ${deviceCode} | User code: ${userCode}`);
  res.json(data);
});

// GET /device/verify → página bonita para autorizar
app.get('/device/verify', (req, res) => {
  const userCode = req.query.user_code || '';
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Autorizar dispositivo</title></head>
<body style="font-family: system-ui; text-align: center; padding: 50px;">
  <h1>Autorizar dispositivo Bashun</h1>
  <p>Código: <strong>${userCode}</strong></p>
  <button onclick="authorize()" style="padding:15px 30px; font-size:18px;">✅ AUTORIZAR ESTE DISPOSITIVO</button>
  <script>
    function authorize() {
      fetch('/device/authorize', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ user_code: '${userCode}' })
      }).then(() => {
        alert('¡Dispositivo autorizado! Ya podés cerrar esta ventana.');
        window.close();
      });
    }
  </script>
</body>
</html>`;
  res.send(html);
});

// POST /device/authorize (llamado desde la página)
app.post('/device/authorize', (req, res) => {
  const { user_code } = req.body;
  for (const [deviceCode, data] of pendingDevices) {
    if (data.user_code === user_code) {
      data.authorized = true;
      data.access_token = 'dummy-' + crypto.randomBytes(32).toString('hex');
      data.refresh_token = 'dummy-refresh-' + crypto.randomBytes(16).toString('hex');
      data.device_id = data.device_id || 'dev-' + Date.now();
      console.log(`[AUTHORIZED] Device ${deviceCode} autorizado`);
      return res.json({ success: true });
    }
  }
  res.status(404).json({ error: 'code not found' });
});

// POST /device/poll
app.post('/device/poll', (req, res) => {
  const { device_code } = req.body;
  const data = pendingDevices.get(device_code);

  if (!data) return res.status(404).json({ error: 'invalid device_code' });

  if (data.authorized) {
    res.json({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      device_id: data.device_id
    });
    // limpiamos después de usar
    setTimeout(() => pendingDevices.delete(device_code), 60000);
  } else {
    res.json({ error: 'authorization_pending' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Bashun Remote Server corriendo en http://localhost:${PORT}`);
  console.log(`   → Apuntá tu remote-device con: MCP_SERVER_URL=https://mcp.zkarmor.com`);
});
