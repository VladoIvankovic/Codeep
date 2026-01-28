/**
 * Interactive Mode - agent asks clarifying questions when needed
 */

export interface ClarificationQuestion {
  question: string;
  options?: string[];
  type: 'choice' | 'text' | 'confirm';
  context?: string;
}

export interface InteractiveContext {
  needsClarification: boolean;
  questions: ClarificationQuestion[];
  originalPrompt: string;
}

// Patterns that indicate ambiguity
const AMBIGUOUS_PATTERNS = [
  {
    pattern: /add\s+(?:an?\s+)?auth(?:entication)?/i,
    question: 'What type of authentication do you want?',
    options: ['JWT tokens', 'Session-based', 'OAuth (Google/GitHub)', 'Basic auth'],
    type: 'choice' as const,
  },
  {
    pattern: /add\s+(?:a\s+)?database/i,
    question: 'Which database do you want to use?',
    options: ['PostgreSQL', 'MySQL', 'MongoDB', 'SQLite', 'Redis'],
    type: 'choice' as const,
  },
  {
    pattern: /create\s+(?:an?\s+)?api/i,
    question: 'What type of API do you want?',
    options: ['REST API', 'GraphQL', 'gRPC', 'WebSocket'],
    type: 'choice' as const,
  },
  {
    pattern: /add\s+(?:a\s+)?form/i,
    question: 'What fields should the form have?',
    type: 'text' as const,
  },
  {
    pattern: /add\s+(?:a\s+)?component/i,
    question: 'Should this be a functional or class component?',
    options: ['Functional (hooks)', 'Class component'],
    type: 'choice' as const,
  },
  {
    pattern: /add\s+(?:a\s+)?test/i,
    question: 'What testing framework should I use?',
    options: ['Vitest', 'Jest', 'Mocha', 'PHPUnit', 'pytest'],
    type: 'choice' as const,
  },
  {
    pattern: /refactor/i,
    question: 'What aspect should I focus on?',
    options: ['Performance', 'Readability', 'Type safety', 'Modularity', 'All of the above'],
    type: 'choice' as const,
  },
  {
    pattern: /add\s+(?:a\s+)?state\s+management/i,
    question: 'Which state management solution?',
    options: ['React Context', 'Redux', 'Zustand', 'MobX', 'Jotai'],
    type: 'choice' as const,
  },
  {
    pattern: /add\s+(?:a\s+)?(?:css|style|styling)/i,
    question: 'Which styling approach?',
    options: ['CSS Modules', 'Tailwind CSS', 'Styled Components', 'SCSS/Sass', 'Plain CSS'],
    type: 'choice' as const,
  },
  {
    pattern: /deploy/i,
    question: 'Where do you want to deploy?',
    options: ['Vercel', 'Netlify', 'AWS', 'Docker', 'Heroku'],
    type: 'choice' as const,
  },
];

/**
 * Analyze prompt for ambiguity and generate clarifying questions
 */
export function analyzeForClarification(prompt: string): InteractiveContext {
  const questions: ClarificationQuestion[] = [];
  
  for (const pattern of AMBIGUOUS_PATTERNS) {
    if (pattern.pattern.test(prompt)) {
      // Check if the prompt already specifies details
      const hasDetails = checkForDetails(prompt, pattern);
      
      if (!hasDetails) {
        questions.push({
          question: pattern.question,
          options: pattern.options,
          type: pattern.type,
        });
      }
    }
  }
  
  return {
    needsClarification: questions.length > 0,
    questions,
    originalPrompt: prompt,
  };
}

/**
 * Check if prompt already contains specific details
 */
function checkForDetails(prompt: string, pattern: typeof AMBIGUOUS_PATTERNS[0]): boolean {
  if (!pattern.options) return false;
  
  const promptLower = prompt.toLowerCase();
  
  // Check if any option is mentioned in the prompt
  for (const option of pattern.options) {
    const optionWords = option.toLowerCase().split(/[\s/()]+/);
    for (const word of optionWords) {
      if (word.length > 3 && promptLower.includes(word)) {
        return true;
      }
    }
  }
  
  return false;
}

/**
 * Format questions for display
 */
export function formatQuestions(context: InteractiveContext): string {
  if (!context.needsClarification) {
    return '';
  }
  
  const lines: string[] = ['I have a few questions before proceeding:', ''];
  
  for (let i = 0; i < context.questions.length; i++) {
    const q = context.questions[i];
    lines.push(`${i + 1}. ${q.question}`);
    
    if (q.options) {
      for (let j = 0; j < q.options.length; j++) {
        lines.push(`   ${String.fromCharCode(97 + j)}) ${q.options[j]}`);
      }
    }
    lines.push('');
  }
  
  lines.push('Please answer the questions or say "proceed" to let me decide.');
  
  return lines.join('\n');
}

/**
 * Parse user's answers to questions
 */
export function parseAnswers(
  response: string,
  context: InteractiveContext
): Map<number, string> {
  const answers = new Map<number, string>();
  const responseLower = response.toLowerCase();
  
  // Check for "proceed" or similar
  if (/proceed|continue|decide|auto|skip/i.test(response)) {
    return answers; // Empty answers = let agent decide
  }
  
  // Try to match answers
  for (let i = 0; i < context.questions.length; i++) {
    const q = context.questions[i];
    
    if (q.options) {
      // Check if user selected an option by letter (a, b, c)
      const letterMatch = response.match(new RegExp(`${i + 1}[.:\\s]*([a-z])`, 'i'));
      if (letterMatch) {
        const letterIndex = letterMatch[1].toLowerCase().charCodeAt(0) - 97;
        if (letterIndex >= 0 && letterIndex < q.options.length) {
          answers.set(i, q.options[letterIndex]);
          continue;
        }
      }
      
      // Check if user mentioned an option directly
      for (const option of q.options) {
        if (responseLower.includes(option.toLowerCase())) {
          answers.set(i, option);
          break;
        }
      }
    } else {
      // Free text - try to extract answer
      const textMatch = response.match(new RegExp(`${i + 1}[.:\\s]*(.+?)(?=\\d+[.:]|$)`, 'i'));
      if (textMatch) {
        answers.set(i, textMatch[1].trim());
      }
    }
  }
  
  return answers;
}

/**
 * Enhance prompt with user's answers
 */
export function enhancePromptWithAnswers(
  context: InteractiveContext,
  answers: Map<number, string>
): string {
  let enhancedPrompt = context.originalPrompt;
  
  const specifications: string[] = [];
  
  for (let i = 0; i < context.questions.length; i++) {
    const q = context.questions[i];
    const answer = answers.get(i);
    
    if (answer) {
      specifications.push(`${q.question} -> ${answer}`);
    }
  }
  
  if (specifications.length > 0) {
    enhancedPrompt += '\n\nUser specifications:\n- ' + specifications.join('\n- ');
  }
  
  return enhancedPrompt;
}

/**
 * Generate interactive prompt for agent
 */
export function getInteractiveSystemPrompt(): string {
  return `
## Interactive Mode
When the task is ambiguous, you may ask clarifying questions before proceeding.
Format your questions like this:

CLARIFICATION_NEEDED:
1. [Question]
   a) Option 1
   b) Option 2
   c) Option 3

The user will respond with their choices. Once you have enough information, proceed with the task.
Only ask questions when truly necessary - don't over-ask.
`;
}
