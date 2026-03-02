/**
 * Prompt Loader
 *
 * Reads markdown prompt templates from prompts/ and interpolates variables.
 * Syntax: {{variableName}} for simple interpolation.
 * Syntax: {{#varName}}...{{/varName}} for conditional sections (rendered only when var is provided).
 */

import * as fs from 'fs';
import * as path from 'path';

const PROMPTS_DIR = path.resolve(__dirname, '..', 'prompts');

export function loadPrompt(name: string, vars: Record<string, string> = {}): string {
  const filePath = path.join(PROMPTS_DIR, `${name}.md`);
  let content = fs.readFileSync(filePath, 'utf-8');

  // Handle conditional sections: {{#key}}...{{/key}}
  for (const [key, value] of Object.entries(vars)) {
    const sectionRegex = new RegExp(`\\{\\{#${key}\\}\\}([\\s\\S]*?)\\{\\{/${key}\\}\\}`, 'g');
    content = value ? content.replace(sectionRegex, '$1') : content.replace(sectionRegex, '');
  }

  // Remove any remaining conditional sections for unset vars
  content = content.replace(/\{\{#\w+\}\}[\s\S]*?\{\{\/\w+\}\}/g, '');

  // Interpolate {{key}} → value
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }

  return content;
}
