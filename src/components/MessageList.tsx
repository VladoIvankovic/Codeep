import React, { memo, useMemo } from 'react';
import { Box, Text } from 'ink';
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
// Maximum number of messages to render at once
// This prevents performance issues and flickering with large chat histories
const MAX_VISIBLE_MESSAGES = 20;

export const MessageList: React.FC<MessageListProps> = memo(({
  messages,
  streamingContent,
}) => {
  // Virtualization: only render the last N messages to prevent flickering
  // Older messages are still in history but not rendered
  const visibleMessages = useMemo(() => {
    if (messages.length <= MAX_VISIBLE_MESSAGES) {
      return messages;
    }
    return messages.slice(-MAX_VISIBLE_MESSAGES);
  }, [messages]);
  
  // Calculate how many messages are hidden
  const hiddenCount = messages.length - visibleMessages.length;
  
  // Memoize the messages array rendering
  const renderedMessages = useMemo(() => (
    visibleMessages.map((msg, index) => (
      <MemoizedMessage key={`msg-${hiddenCount + index}-${msg.role}`} msg={msg} index={hiddenCount + index} />
    ))
  ), [visibleMessages, hiddenCount]);

  return (
    <Box flexDirection="column">
      {/* Show indicator if messages are hidden */}
      {hiddenCount > 0 && (
        <Box marginBottom={1}>
          <Text color="gray">... {hiddenCount} earlier message(s) hidden ...</Text>
        </Box>
      )}
      
      {/* Messages - only render visible subset */}
      {renderedMessages}
      
      {/* Streaming content - renders for live updates */}
      {streamingContent && (
        <StreamingMessage content={streamingContent} />
      )}
    </Box>
  );
});

MessageList.displayName = 'MessageList';
