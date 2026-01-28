import React from 'react';
import { Box, Static } from 'ink';
import { MessageView } from './Message';
import { Message } from '../config';

interface MessageListProps {
  messages: Message[];
  streamingContent?: string;
  scrollOffset: number;
  terminalHeight: number;
}

export const MessageList: React.FC<MessageListProps> = ({
  messages,
}) => {
  // Use Static component to prevent messages from re-rendering on every keystroke
  // This keeps the scroll position stable when typing in input field
  
  return (
    <Box flexDirection="column">
      <Static items={messages}>
        {(msg, index) => (
          <MessageView key={index} role={msg.role} content={msg.content} />
        )}
      </Static>
    </Box>
  );
};
