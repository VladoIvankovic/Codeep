#!/usr/bin/env node
/**
 * Demo/Test for custom renderer
 * Run with: npx ts-node src/renderer/demo.ts
 */

import { ChatUI } from './ChatUI';

// Simulate streaming response
function simulateStreaming(ui: ChatUI, text: string): Promise<void> {
  return new Promise((resolve) => {
    ui.startStreaming();
    
    let index = 0;
    const words = text.split(' ');
    
    const interval = setInterval(() => {
      if (index >= words.length) {
        clearInterval(interval);
        ui.endStreaming();
        resolve();
        return;
      }
      
      ui.addStreamChunk((index > 0 ? ' ' : '') + words[index]);
      index++;
    }, 50); // 50ms per word
  });
}

// Main
async function main() {
  const ui = new ChatUI({
    onSubmit: async (message) => {
      // Simulate AI response
      const responses: Record<string, string> = {
        'hello': 'Hello! How can I help you today?',
        'hi': 'Hi there! What would you like to do?',
        'help': 'Available commands:\n- Type any message to chat\n- Ctrl+L to clear\n- Ctrl+C to exit\n- Page Up/Down to scroll',
        'test': 'This is a test response. The custom renderer is working correctly without Ink!\n\nIt supports:\n- Multi-line messages\n- Word wrapping for long lines\n- Streaming responses\n- Scroll history\n- Cursor-based input editing',
      };
      
      const response = responses[message.toLowerCase()] || 
        `You said: "${message}"\n\nThis is a simulated response from the custom renderer. No Ink involved - just pure ANSI escape codes and a virtual screen buffer with diff-based rendering.`;
      
      await simulateStreaming(ui, response);
    },
    onExit: () => {
      console.log('\nGoodbye!');
      process.exit(0);
    },
  });
  
  // Add welcome message
  ui.addMessage({
    role: 'system',
    content: 'Welcome to Codeep Custom Renderer Demo!\nType "help" for commands, or just start chatting.',
  });
  
  ui.start();
}

main().catch(console.error);
