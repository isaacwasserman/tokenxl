import type { ModelMessage, ToolSet } from 'ai'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { jsonSchema, tool } from 'ai'
import { z } from 'zod'

const textsDir = resolve(import.meta.dirname, '../test/fixtures/texts')

/** Ten tools with schemas of increasing size. */
export function createBenchTools(): ToolSet {
  return {
    getWeather: tool({
      description: 'Get the current weather for a city.',
      inputSchema: z.object({ city: z.string().describe('The city name'), unit: z.enum(['celsius', 'fahrenheit']).optional() }),
    }),
    searchDocs: tool({
      description: 'Search the documentation and return the best matches.',
      inputSchema: z.object({
        query: z.string().describe('The search query'),
        limit: z.number().int().min(1).max(50).optional(),
        filter: z.object({ section: z.string(), version: z.string().nullable() }).optional(),
      }),
    }),
    readFile: tool({
      description: 'Read a file from the workspace.',
      inputSchema: z.object({ path: z.string().describe('Path relative to the workspace root'), encoding: z.enum(['utf8', 'base64']) }),
    }),
    writeFile: tool({
      description: 'Write a file to the workspace.',
      inputSchema: z.object({ path: z.string(), content: z.string().describe('The full file content'), createDirectories: z.boolean().optional() }),
    }),
    runCommand: tool({
      description: 'Run a shell command and return its output.',
      inputSchema: z.object({ command: z.string(), cwd: z.string().optional(), timeoutMs: z.number().optional(), env: z.record(z.string(), z.string()).optional() }),
    }),
    createIssue: tool({
      description: 'Create an issue in the tracker.',
      inputSchema: z.object({
        title: z.string(),
        body: z.string().describe('Markdown body'),
        labels: z.array(z.string()),
        priority: z.enum(['low', 'medium', 'high', 'urgent']),
        assignees: z.array(z.object({ id: z.string(), role: z.enum(['owner', 'reviewer']) })),
      }),
    }),
    queryDatabase: tool({
      description: 'Run a read-only SQL query.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'The SQL statement' },
          params: { type: 'array', items: { type: 'string' } },
        },
        required: ['sql'],
      }),
    }),
    sendMessage: tool({
      description: 'Send a chat message to a channel.',
      inputSchema: z.object({ channel: z.string(), text: z.string(), thread: z.string().optional() }),
    }),
    listReleases: tool({
      description: 'List the releases of a repository.',
      inputSchema: z.object({ owner: z.string(), repo: z.string(), page: z.number().optional() }),
    }),
    planTrip: tool({
      description: 'Plan a trip with several stops.',
      inputSchema: z.object({
        traveler: z.object({ name: z.string(), age: z.number().optional() }),
        stops: z.array(z.object({
          city: z.string().describe('Stop city'),
          nights: z.number(),
          activities: z.array(z.object({ name: z.string(), kind: z.enum(['food', 'museum', 'outdoor']) })),
        })),
      }),
    }),
  }
}

/** A 50-message conversation built from the fixture texts, with tool calls and results. */
export async function createBenchConversation(): Promise<ModelMessage[]> {
  const [chat, gatsby, docs, releases, german] = await Promise.all(
    ['chat-transcript-en.txt', 'great-gatsby-en.txt', 'vite-plugin-api-en.txt', 'github-releases-api.txt', 'die-verwandlung-de.txt']
      .map(file => readFile(resolve(textsDir, file), 'utf-8')),
  )
  const paragraphs = [chat!, ...gatsby!.split('\n'), ...docs!.split('\n\n'), ...german!.split('\n')].filter(Boolean)
  const releaseItems = JSON.parse(releases!) as unknown[]

  const messages: ModelMessage[] = [{ role: 'system', content: paragraphs.slice(0, 3).join('\n') }]
  for (let turn = 0; messages.length < 50; turn++) {
    messages.push({ role: 'user', content: [{ type: 'text', text: paragraphs[(turn * 7) % paragraphs.length]! }] })
    if (turn % 3 === 0) {
      const toolCallId = `call_${turn}`
      messages.push({
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check the releases.' },
          { type: 'tool-call', toolCallId, toolName: 'listReleases', input: { owner: 'vitejs', repo: 'vite', page: turn } },
        ],
      })
      messages.push({
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId, toolName: 'listReleases', output: { type: 'json', value: releaseItems[turn % releaseItems.length] as never } }],
      })
    }
    else {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: paragraphs[(turn * 11 + 5) % paragraphs.length]! }] })
    }
  }
  return messages.slice(0, 50)
}
