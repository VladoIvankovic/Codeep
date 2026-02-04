#!/usr/bin/env node
/**
 * Demo for full App with modals
 * Run with: npm run demo:app
 */

import { App } from './App';
import { StatusInfo } from './components/Status';

// Simulate API response
function simulateResponse(app: App, text: string): Promise<void> {
  return new Promise((resolve) => {
    app.startStreaming();
    
    let index = 0;
    const words = text.split(' ');
    
    const interval = setInterval(() => {
      if (index >= words.length) {
        clearInterval(interval);
        app.endStreaming();
        resolve();
        return;
      }
      
      app.addStreamChunk((index > 0 ? ' ' : '') + words[index]);
      index++;
    }, 30);
  });
}

// Mock status
function getStatus(): StatusInfo {
  return {
    version: '1.1.12',
    provider: 'OpenAI',
    model: 'gpt-4o',
    agentMode: 'on',
    projectPath: process.cwd(),
    hasWriteAccess: true,
    sessionId: 'demo-session',
    messageCount: 0,
  };
}

// Main
async function main() {
  const app = new App({
    onSubmit: async (message) => {
      // Simulate AI response
      const responses: Record<string, string> = {
        'hello': 'Hello! I\'m Codeep, your AI coding assistant. How can I help you today?',
        'hi': 'Hi there! What would you like to work on?',
        'test': 'This is the full App demo with:\n\n• Help screen (/help)\n• Status screen (/status)\n• Modal overlays\n• Streaming responses\n• All keyboard shortcuts\n\nThe custom renderer is working perfectly!',
      };
      
      const response = responses[message.toLowerCase()] || 
        `You said: "${message}"\n\nI'm a demo response. In the real app, this would be an AI-generated response based on your project context.`;
      
      await simulateResponse(app, response);
    },
    onCommand: (command, args) => {
      // Handle commands not built into App
      switch (command) {
        case 'version':
          app.notify('Codeep v1.1.12 • OpenAI • gpt-4o');
          break;
        case 'provider':
          app.showList('Select Provider', ['OpenAI', 'Anthropic', 'Google', 'Local'], (index) => {
            app.notify(`Selected: ${['OpenAI', 'Anthropic', 'Google', 'Local'][index]}`);
          });
          break;
        case 'model':
          app.showList('Select Model', ['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo', 'o1-preview'], (index) => {
            app.notify(`Selected model: ${['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo', 'o1-preview'][index]}`);
          });
          break;
        default:
          app.notify(`Unknown command: /${command}`);
      }
    },
    onExit: () => {
      console.log('\nGoodbye!');
      process.exit(0);
    },
    getStatus,
  });
  
  // Welcome message
  app.addMessage({
    role: 'system',
    content: 'Welcome to Codeep App Demo!\n\nTry these commands:\n• /help - Show help\n• /status - Show status\n• /provider - Select provider\n• /model - Select model\n• /clear - Clear chat\n• /exit - Quit',
  });
  
  app.start();
}

main().catch(console.error);
