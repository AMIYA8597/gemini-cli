/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { BasePlugin, type BaseTool, type ToolContext } from '@google/adk';
import { type AnyDeclarativeTool } from '../index.js';
import { randomUUID } from 'node:crypto';
import type { MessageBus } from './message-bus.js';
import { MessageBusType, type ToolConfirmationResponse } from './types.js';
import { AdkToolAdapter } from '../tools/tools.js';

export class MessageBusPlugin extends BasePlugin {
  constructor(private readonly messageBus: MessageBus) {
    super('message-bus-plugin');
  }

  override async beforeToolCallback({
    tool,
    toolArgs,
  }: {
    tool: BaseTool;
    toolArgs: { [key: string]: unknown };
    toolContext: ToolContext;
  }): Promise<{ [key: string]: unknown } | undefined> {
    let declarativeTool: AnyDeclarativeTool;
    if (tool instanceof AdkToolAdapter) {
      declarativeTool = tool.tool;
    } else {
      // This shouldn't happen; the wrong type of tool was passed in.
      throw new Error('Invalid tool type passed: ' + tool);
    }
    const invocation = declarativeTool.build(toolArgs);
    const confirmationDetails = await invocation.shouldConfirmExecute(
      new AbortController().signal,
    );
    if (!confirmationDetails) {
      return Promise.resolve(undefined);
    }

    const correlationId = randomUUID();
    if (confirmationDetails) {
      this.messageBus.publish({
        type: MessageBusType.TOOL_CONFIRMATION_DISPLAY_REQUEST,
        correlationId,
        tool: declarativeTool,
        invocation,
        toolArgs,
        confirmationDetails,
      });
    }

    return new Promise((resolve, reject) => {
      const responseHandler = (response: ToolConfirmationResponse) => {
        if (response.correlationId === correlationId) {
          this.messageBus.unsubscribe(
            MessageBusType.TOOL_CONFIRMATION_RESPONSE,
            responseHandler,
          );
          if (response.confirmed) {
            resolve(undefined); // Proceed with tool call
          } else {
            // This will be caught by the runner and returned as a tool error
            reject(new Error('Tool execution was denied.'));
          }
        }
      };

      this.messageBus.subscribe(
        MessageBusType.TOOL_CONFIRMATION_RESPONSE,
        responseHandler,
      );
    });
  }
}
