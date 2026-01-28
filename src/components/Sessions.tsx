import React, { useState } from 'react';
import { Text, Box, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { Message, listSessions, saveSession, loadSession, deleteSession } from '../config/index';

interface SessionsProps {
  history: Message[];
  onLoad: (history: Message[], name: string) => void;
  onClose: () => void;
  onDelete?: (name: string) => void;
  deleteMode?: boolean; // Auto-trigger delete when opened
  projectPath?: string; // For local session storage
}

export const Sessions: React.FC<SessionsProps> = ({ history, onLoad, onClose, onDelete, deleteMode = false, projectPath }) => {
  const [name, setName] = useState('');
  const [message, setMessage] = useState(deleteMode ? 'Select a session to delete (D or Enter)' : '');
  const [sessions, setSessions] = useState(listSessions(projectPath));
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useInput((input, key) => {
    // Handle delete confirmation
    if (confirmDelete) {
      if (input === 'y' || input === 'Y') {
        if (deleteSession(confirmDelete, projectPath)) {
          setMessage(`Deleted: ${confirmDelete}`);
          setSessions(listSessions(projectPath));
          if (onDelete) onDelete(confirmDelete);
        } else {
          setMessage('Failed to delete');
        }
        setConfirmDelete(null);
      } else if (input === 'n' || input === 'N' || key.escape) {
        setConfirmDelete(null);
        setMessage('Delete cancelled');
      }
      return;
    }

    if (key.escape) {
      onClose();
      return;
    }

    if (key.upArrow && sessions.length > 0) {
      setSelectedIndex(i => Math.max(0, i - 1));
      setName(sessions[Math.max(0, selectedIndex - 1)] || '');
    }

    if (key.downArrow && sessions.length > 0) {
      setSelectedIndex(i => Math.min(sessions.length - 1, i + 1));
      setName(sessions[Math.min(sessions.length - 1, selectedIndex + 1)] || '');
    }

    // In delete mode, Enter also triggers delete
    if (deleteMode && key.return) {
      handleDelete();
      return;
    }

    // S = Save, L = Load, D = Delete
    if (!deleteMode && (input === 's' || input === 'S')) {
      handleSave();
    }
    if (!deleteMode && (input === 'l' || input === 'L')) {
      handleLoad();
    }
    if (input === 'd' || input === 'D') {
      handleDelete();
    }
  });

  const handleSave = () => {
    if (!name.trim()) {
      setMessage('Enter session name');
      return;
    }
    if (history.length === 0) {
      setMessage('Nothing to save');
      return;
    }
    if (saveSession(name.trim(), history, projectPath)) {
      setMessage(`Saved: ${name}`);
      setTimeout(onClose, 1000);
    } else {
      setMessage('Failed to save');
    }
  };

  const handleLoad = () => {
    if (!name.trim()) {
      setMessage('Enter session name');
      return;
    }
    const loaded = loadSession(name.trim(), projectPath);
    if (loaded) {
      onLoad(loaded, name.trim());
    } else {
      setMessage('Session not found');
    }
  };

  const handleDelete = () => {
    const sessionName = name.trim() || (sessions.length > 0 ? sessions[selectedIndex] : '');
    if (!sessionName) {
      setMessage('Select a session to delete');
      return;
    }
    // Ask for confirmation
    setConfirmDelete(sessionName);
    setMessage(`Delete "${sessionName}"? (Y/N)`);
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#f02a30" padding={1}>
      <Text color="#f02a30" bold>{deleteMode ? 'Delete Session' : 'Sessions'}</Text>
      <Text> </Text>
      
      {!deleteMode && (
        <>
          <Box>
            <Text color="#f02a30">Name: </Text>
            <TextInput
              value={name}
              onChange={setName}
              placeholder="session name..."
            />
          </Box>

          <Text> </Text>
          <Text>Actions: <Text color="#f02a30">S</Text>=Save  <Text color="#f02a30">L</Text>=Load  <Text color="#f02a30">D</Text>=Delete  <Text color="#f02a30">Esc</Text>=Close</Text>
        </>
      )}

      {deleteMode && (
        <>
          <Text>Actions: <Text color="#f02a30">Enter/D</Text>=Delete  <Text color="#f02a30">Esc</Text>=Cancel</Text>
        </>
      )}

      {sessions.length > 0 && (
        <>
          <Text> </Text>
          <Text>Saved sessions (↑/↓ to select):</Text>
          {sessions.map((s, i) => (
            <Text key={s}>
              {i === selectedIndex ? <Text color="#f02a30">▸ </Text> : '  '}
              <Text color={i === selectedIndex ? '#f02a30' : undefined}>{s}</Text>
            </Text>
          ))}
        </>
      )}

      {message && (
        <>
          <Text> </Text>
          <Text color="cyan">{message}</Text>
        </>
      )}
    </Box>
  );
};
