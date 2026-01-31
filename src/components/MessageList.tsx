import React, { memo, useMemo } from 'react';
import { Box } from 'ink';
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
 * Memoized individual message component
 * Only re-renders when its specific content changes
 */
const MemoizedMessage = memo<{ msg: Message; index: number }>(
  ({ msg }) => <MessageView role={msg.role} content={msg.content} />,
  (prev, next) => prev.msg.content === next.msg.content && prev.msg.role === next.msg.role
);

MemoizedMessage.displayName = 'MemoizedMessage';

/**
 * Message list WITHOUT Static component
 * 
 * We removed the Static component because:
 * - Static preserves content in terminal scroll history even after unmount
 * - This causes ghost/duplicate content when switching screens
 * - The trade-off is that messages will re-render on each update
 * - We mitigate this with memoization at the individual message level
 * 
 * NOTE: This is a temporary solution until we implement a custom renderer
 * like Claude CLI uses (DEC Mode 2026 / synchronized output).
 */
export const MessageList: React.FC<MessageListProps> = memo(({
  messages,
  streamingContent,
}) => {
  // Memoize the messages array rendering
  const renderedMessages = useMemo(() => (
    messages.map((msg, index) => (
      <MemoizedMessage key={`msg-${index}-${msg.role}`} msg={msg} index={index} />
    ))
  ), [messages]);

  return (
    <Box flexDirection="column">
      {/* Messages - render normally with memoization */}
      {renderedMessages}
      
      {/* Streaming content - renders for live updates */}
      {streamingContent && (
        <StreamingMessage content={streamingContent} />
      )}
    </Box>
  );
});

MessageList.displayName = 'MessageList';
