import React, { memo } from 'react';
import { Box, Static } from 'ink';
import { MessageView } from './Message';
import { StreamingMessage } from './StreamingMessage';
import { Message } from '../config/index';

interface MessageListProps {
  messages: Message[];
  streamingContent?: string;
  scrollOffset?: number;
  terminalHeight?: number;
}

/**
 * Generate unique key for message based on content and position
 * More stable than index-based keys
 */
const getMessageKey = (msg: Message, index: number): string => {
  // Use hash of first 50 chars + role + index for uniqueness
  const contentHash = msg.content.slice(0, 50).split('').reduce((acc, char) => {
    return ((acc << 5) - acc) + char.charCodeAt(0);
  }, 0);
  return `${msg.role}-${index}-${Math.abs(contentHash)}`;
};

/**
 * Message list with optimized rendering
 * Uses Static component for stable scroll position
 * Uses content-based keys instead of index for better React reconciliation
 */
export const MessageList: React.FC<MessageListProps> = memo(({
  messages,
  streamingContent,
}) => {
  return (
    <Box flexDirection="column">
      {/* Static messages - won't re-render on every keystroke */}
      <Static items={messages}>
        {(msg, index) => (
          <MessageView 
            key={getMessageKey(msg, index)} 
            role={msg.role} 
            content={msg.content} 
          />
        )}
      </Static>
      
      {/* Streaming content - renders outside Static for live updates */}
      {streamingContent && (
        <StreamingMessage content={streamingContent} />
      )}
    </Box>
  );
});

MessageList.displayName = 'MessageList';
