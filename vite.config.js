import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const latestPayloads = new Map()

function installWidgetSyncMiddleware(server) {
  server.middlewares.use('/api/sync', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    const requestUrl = new URL(req.url, 'http://localhost')

    if (req.method === 'GET') {
      const room = requestUrl.searchParams.get('room')
      res.setHeader('Content-Type', 'application/json')
      res.statusCode = room ? 200 : 400
      res.end(JSON.stringify(room ? latestPayloads.get(room) || {} : { error: 'room is required' }))
      return
    }

    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end(JSON.stringify({ error: 'Method not allowed' }))
      return
    }

    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      try {
        const { room, payload } = JSON.parse(body)
        if (!room || !payload?.state || !payload.timestamp) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'room and a timestamped payload are required' }))
          return
        }

        latestPayloads.set(room, payload)
        res.statusCode = 200
        res.end(JSON.stringify({ success: true }))
      } catch {
        res.statusCode = 400
        res.end(JSON.stringify({ error: 'Invalid JSON payload' }))
      }
    })
  })
}

function widgetSyncPlugin() {
  return {
    name: 'rekasong-widget-sync',
    configureServer(server) {
      installWidgetSyncMiddleware(server)
    },
    configurePreviewServer(server) {
      installWidgetSyncMiddleware(server)
    }
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), widgetSyncPlugin()],
  base: process.env.GITHUB_ACTIONS ? '/rekasong/' : '/',
  build: {
    manifest: true,
  },
})
