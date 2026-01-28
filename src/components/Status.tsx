import React from 'react';
import { Text, Box } from 'ink';
import { config, getMaskedApiKey, getModelsForCurrentProvider, getCurrentProvider, PROTOCOLS, LANGUAGES } from '../config/index';

export const Status: React.FC = () => {
  const model = config.get('model');
  const protocol = config.get('protocol');
  const plan = config.get('plan');
  const language = config.get('language');
  const provider = getCurrentProvider();
  const models = getModelsForCurrentProvider();

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#f02a30" padding={1}>
      <Text color="#f02a30" bold>Status</Text>
      <Text> </Text>
      <Text><Text color="#f02a30">Provider:</Text> {provider.name}</Text>
      <Text><Text color="#f02a30">Model:</Text>    {models[model] || model}</Text>
      <Text><Text color="#f02a30">Protocol:</Text> {PROTOCOLS[protocol] || protocol}</Text>
      <Text><Text color="#f02a30">Language:</Text> {LANGUAGES[language] || language}</Text>
      <Text><Text color="#f02a30">Plan:</Text>     {plan.toUpperCase()}</Text>
      <Text><Text color="#f02a30">API Key:</Text>  {getMaskedApiKey()}</Text>
    </Box>
  );
};
