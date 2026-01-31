/**
 * Streaming message component
 * Isolates streaming state from main App to reduce re-renders
 */

import React, { memo } from 'react';
import { Box } from 'ink';
import { MessageView } from './Message';

interface StreamingMessageProps {
  content: string;
}

/**
 * Displays streaming content as it arrives
 * Wrapped in memo to prevent unnecessary re-renders when content hasn't changed
 */
export const StreamingMessage: React.FC<StreamingMessageProps> = memo(({ content }) => {
  if (!content) return null;
  
  return (
    <Box flexDirection="column">
      <MessageView role="assistant" content={content} />
    </Box>
  );
});

StreamingMessage.displayName = 'StreamingMessage';

export default StreamingMessage;
