import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { macBridge } from './server/macBridge.ts'

// macBridge() serves /local/* (Mac hardware + LM Studio control) and proxies
// /llm/* to your model server. It finds LM Studio's port automatically; set
// LLM_SERVER=http://localhost:11434 in .env to point at Ollama or anything else
// that speaks the OpenAI API.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), macBridge({ llmServer: env.LLM_SERVER })],
    build: { chunkSizeWarningLimit: 1000 },
    server: { port: 5173 },
  }
})
