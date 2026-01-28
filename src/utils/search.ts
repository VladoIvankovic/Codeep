import { Message } from '../config/index';

export interface SearchResult {
  messageIndex: number;
  role: 'user' | 'assistant';
  content: string;
  matchedText: string;
}

/**
 * Search through chat history for a term
 */
export function searchMessages(messages: Message[], searchTerm: string): SearchResult[] {
  const results: SearchResult[] = [];
  const term = searchTerm.toLowerCase();

  messages.forEach((message, index) => {
    const content = message.content.toLowerCase();
    
    if (content.includes(term)) {
      // Find the matching snippet with context
      const matchIndex = content.indexOf(term);
      const start = Math.max(0, matchIndex - 50);
      const end = Math.min(content.length, matchIndex + term.length + 50);
      
      let snippet = message.content.substring(start, end);
      
      // Add ellipsis if truncated
      if (start > 0) snippet = '...' + snippet;
      if (end < content.length) snippet = snippet + '...';

      results.push({
        messageIndex: index,
        role: message.role as 'user' | 'assistant',
        content: message.content,
        matchedText: snippet,
      });
    }
  });

  return results;
}
