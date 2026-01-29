/**
 * Task Planning - breaks down complex tasks into subtasks
 */

import { config, getApiKey, Message } from '../config/index';
import { getProviderBaseUrl, getProviderAuthHeader } from '../config/providers';

export interface SubTask {
  id: number;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  dependencies?: number[]; // IDs of tasks that must complete first
}

export interface TaskPlan {
  originalPrompt: string;
  tasks: SubTask[];
  estimatedIterations: number;
}

/**
 * Ask AI to break down a complex task into subtasks
 */
export async function planTasks(
  userPrompt: string,
  projectContext: { name: string; type: string; structure: string }
): Promise<TaskPlan> {
  const systemPrompt = `You are a task planning expert. Break down user requests into clear, sequential subtasks.

RULES:
1. Create 3-10 subtasks maximum (keep it focused)
2. Each subtask should be specific and achievable in 2-5 tool calls
3. Order tasks logically - one file/component per task
4. Use simple, clear descriptions
5. For websites: separate HTML, CSS, JS into different tasks
6. Respond ONLY with a JSON object, no other text

Example for "create a website":
{
  "tasks": [
    {"id": 1, "description": "Create directory structure", "dependencies": []},
    {"id": 2, "description": "Create index.html with page structure", "dependencies": [1]},
    {"id": 3, "description": "Create styles.css with layout and design", "dependencies": [1]},
    {"id": 4, "description": "Create script.js with interactive features", "dependencies": [1]},
    {"id": 5, "description": "Add content and finalize all pages", "dependencies": [2, 3, 4]}
  ]
}

Project Context:
- Name: ${projectContext.name}
- Type: ${projectContext.type}

User Request: ${userPrompt}

Break this down into subtasks. Each task = one file or one logical unit. Respond with JSON only.`;

  try {
    const apiKey = await getApiKey();
    if (!apiKey) {
      throw new Error('No API key configured');
    }

    const protocol = config.get('protocol') as 'openai' | 'anthropic';
    const provider = config.get('provider');
    const model = config.get('model');
    const baseUrl = getProviderBaseUrl(provider, protocol);
    const authHeaderType = getProviderAuthHeader(provider, protocol);

    const messages: Message[] = [
      { role: 'user', content: systemPrompt }
    ];

    const requestBody = protocol === 'anthropic'
      ? {
          model,
          max_tokens: 2048,
          messages,
          system: 'You are a task planning assistant. Respond with JSON only.',
        }
      : {
          model,
          messages: [
            { role: 'system', content: 'You are a task planning assistant. Respond with JSON only.' },
            ...messages
          ],
          temperature: 0.3,
          max_tokens: 2048,
        };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    if (authHeaderType === 'x-api-key') {
      headers['x-api-key'] = apiKey;
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.statusText}`);
    }

    const data = await response.json();
    const content = protocol === 'anthropic' 
      ? data.content?.[0]?.text || ''
      : data.choices?.[0]?.message?.content || '';

    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = content.trim();
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```\n?/g, '');
    }

    const parsed = JSON.parse(jsonStr);
    
    // Validate and convert to TaskPlan
    const tasks: SubTask[] = parsed.tasks.map((t: any, index: number) => ({
      id: t.id || index + 1,
      description: t.description,
      status: 'pending' as const,
      dependencies: t.dependencies || [],
    }));

    return {
      originalPrompt: userPrompt,
      tasks,
      estimatedIterations: tasks.length * 3, // Rough estimate
    };
  } catch (error) {
    // Fallback: create a single task
    return {
      originalPrompt: userPrompt,
      tasks: [
        {
          id: 1,
          description: userPrompt,
          status: 'pending',
          dependencies: [],
        }
      ],
      estimatedIterations: 10,
    };
  }
}

/**
 * Check if a task's dependencies are completed
 */
export function canStartTask(task: SubTask, allTasks: SubTask[]): boolean {
  if (!task.dependencies || task.dependencies.length === 0) {
    return true;
  }

  return task.dependencies.every(depId => {
    const depTask = allTasks.find(t => t.id === depId);
    return depTask?.status === 'completed';
  });
}

/**
 * Get next task to execute
 */
export function getNextTask(tasks: SubTask[]): SubTask | null {
  return tasks.find(t => 
    t.status === 'pending' && canStartTask(t, tasks)
  ) || null;
}

/**
 * Format task plan for display
 */
export function formatTaskPlan(plan: TaskPlan): string {
  const lines = ['Task Plan:', ''];
  
  plan.tasks.forEach(task => {
    const icon = task.status === 'completed' ? '✓' 
               : task.status === 'in_progress' ? '⏳'
               : task.status === 'failed' ? '✗'
               : '⏸';
    
    const deps = task.dependencies && task.dependencies.length > 0
      ? ` (after: ${task.dependencies.join(', ')})`
      : '';
    
    lines.push(`${icon} ${task.id}. ${task.description}${deps}`);
  });
  
  lines.push('');
  lines.push(`Estimated iterations: ~${plan.estimatedIterations}`);
  
  return lines.join('\n');
}
