/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { getDirectoryContextString } from '../utils/environmentContext.js';
import type { AgentDefinition, AgentInputs } from './types.js';
import { templateString } from './utils.js';
import { TASK_COMPLETE_TOOL_NAME } from './executor.js';
import { type z } from 'zod';

/** Builds the system prompt from the agent definition and inputs. */
export async function buildSystemPrompt<TOutput extends z.ZodTypeAny>(
  inputs: AgentInputs,
  definition: AgentDefinition<TOutput>,
  runtimeContext: Config,
): Promise<string> {
  const { promptConfig } = definition;
  if (!promptConfig.systemPrompt) {
    return '';
  }

  // If the system prompt is a function, send through the config and return.
  if (typeof promptConfig.systemPrompt === 'function') {
    return promptConfig.systemPrompt(runtimeContext);
  }

  // Else, inject user inputs into the prompt template.
  let finalPrompt = templateString(promptConfig.systemPrompt, inputs);

  // Append environment context (CWD and folder structure).
  const dirContext = await getDirectoryContextString(runtimeContext);
  finalPrompt += `\n\n# Environment Context\n${dirContext}`;

  // Append standard rules for non-interactive execution.
  finalPrompt += `
Important Rules:
* You are running in a non-interactive mode. You CANNOT ask the user for input or clarification.
* Work systematically using available tools to complete your task.
* Always use absolute paths for file operations. Construct them using the provided "Environment Context".`;

  finalPrompt += `
* When you have completed your task, you MUST call the \`${TASK_COMPLETE_TOOL_NAME}\` tool.
* Do not call any other tools in the same turn as \`${TASK_COMPLETE_TOOL_NAME}\`.
* This is the ONLY way to complete your mission. If you stop calling tools without calling this, you have failed.`;

  return finalPrompt;
}
