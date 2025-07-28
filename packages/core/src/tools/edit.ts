/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as Diff from 'diff';
import {
  BaseTool,
  Icon,
  ToolCallConfirmationDetails,
  ToolConfirmationOutcome,
  ToolEditConfirmationDetails,
  ToolLocation,
  ToolResult,
  ToolResultDisplay,
} from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { isNodeError } from '../utils/errors.js';
import { Config, ApprovalMode } from '../config/config.js';
import { ensureCorrectEdit, countOccurrences } from '../utils/editCorrector.js';
import { DEFAULT_DIFF_OPTIONS } from './diffOptions.js';
import { ReadFileTool } from './read-file.js';
import { ModifiableTool, ModifyContext } from './modifiable-tool.js';
import { isWithinRoot } from '../utils/fileUtils.js';
import process from 'node:process';
/**
 * Parameters for the Edit tool
 */
export interface EditToolParams {
  /**
   * The absolute path to the file to modify
   */
  file_path: string;

  /**
   * The text to replace
   */
  old_string: string;

  /**
   * The text to replace it with
   */
  new_string: string;

  /**
   * Number of replacements expected. Defaults to 1 if not specified.
   * Use when you want to replace multiple occurrences.
   */
  expected_replacements?: number;

  /**
   * Whether the edit was modified manually by the user.
   */
  modified_by_user?: boolean;
}

interface CalculatedEdit {
  currentContent: string | null;
  newContent: string;
  occurrences: number;
  error?: { display: string; raw: string };
  isNewFile: boolean;
}

/**
 * Implementation of the Edit tool logic
 */
export class EditTool
  extends BaseTool<EditToolParams, ToolResult>
  implements ModifiableTool<EditToolParams>
{
  static readonly Name = 'replace';
  edit_mode: string;

  constructor(private readonly config: Config) {
    // calculate edit mode
    let edit_mode = 'search_and_replace';
    // CHANGED: Correctly assign to this.edit_mode instead of a local variable.
    if (process.env.FUZZY_EDITOR !== undefined) {
      edit_mode = 'fuzzy_search_and_replace';
    } else if (process.env.SMART_EDITOR !== undefined) {
      edit_mode = 'smart';
    } else if (process.env.DIFF_EDITOR !== undefined) {
      edit_mode = 'diff';
    } else if (process.env.ENSURE_CORRECT_EDITOR) {
      edit_mode = 'search_and_replace_corrector';
    }
    super(
      EditTool.Name,
      'Edit',
      `Replaces text within a file. By default, replaces a single occurrence, but can replace multiple occurrences when \`expected_replacements\` is specified. This tool requires providing significant context around the change to ensure precise targeting. Always use the ${ReadFileTool.Name} tool to examine the file's current content before attempting a text replacement.

      The user has the ability to modify the \`new_string\` content. If modified, this will be stated in the response.

Expectation for required parameters:
1. \`file_path\` MUST be an absolute path; otherwise an error will be thrown.
2. \`old_string\` MUST be the exact literal text to replace (including all whitespace, indentation, newlines, and surrounding code etc.).
3. \`new_string\` MUST be the exact literal text to replace \`old_string\` with (also including all whitespace, indentation, newlines, and surrounding code etc.). Ensure the resulting code is correct and idiomatic.
4. NEVER escape \`old_string\` or \`new_string\`, that would break the exact literal text requirement.
**Important:** If ANY of the above are not satisfied, the tool will fail. CRITICAL for \`old_string\`: Must uniquely identify the single instance to change. Include at least 3 lines of context BEFORE and AFTER the target text, matching whitespace and indentation precisely. If this string matches multiple locations, or does not match exactly, the tool will fail.
**Multiple replacements:** Set \`expected_replacements\` to the number of occurrences you want to replace. The tool will replace ALL occurrences that match \`old_string\` exactly. Ensure the number of replacements matches your expectation.`,
      Icon.Pencil,
      {
        properties: {
          file_path: {
            description:
              "The absolute path to the file to modify. Must start with '/'.",
            type: Type.STRING,
          },
          old_string: {
            description:
              'The exact literal text to replace, preferably unescaped. For single replacements (default), include at least 3 lines of context BEFORE and AFTER the target text, matching whitespace and indentation precisely. For multiple replacements, specify expected_replacements parameter. If this string is not the exact literal text (i.e. you escaped it) or does not match exactly, the tool will fail.',
            type: Type.STRING,
          },
          new_string: {
            description:
              'The exact literal text to replace `old_string` with, preferably unescaped. Provide the EXACT text. Ensure the resulting code is correct and idiomatic.',
            type: Type.STRING,
          },
          expected_replacements: {
            type: Type.NUMBER,
            description:
              'Number of replacements expected. Defaults to 1 if not specified. Use when you want to replace multiple occurrences.',
            minimum: 1,
          },
        },
        required: ['file_path', 'old_string', 'new_string'],
        type: Type.OBJECT,
      },
    );
    this.edit_mode = edit_mode;
  }
  /**
   * Validates the parameters for the Edit tool
   * @param params Parameters to validate
   * @returns Error message string or null if valid
   */
  validateToolParams(params: EditToolParams): string | null {
    const errors = SchemaValidator.validate(this.schema.parameters, params);
    if (errors) {
      return errors;
    }

    if (!path.isAbsolute(params.file_path)) {
      return `File path must be absolute: ${params.file_path}`;
    }

    if (!isWithinRoot(params.file_path, this.config.getTargetDir())) {
      return `File path must be within the root directory (${this.config.getTargetDir()}): ${params.file_path}`;
    }

    return null;
  }

  /**
   * Determines any file locations affected by the tool execution
   * @param params Parameters for the tool execution
   * @returns A list of such paths
   */
  toolLocations(params: EditToolParams): ToolLocation[] {
    return [{ path: params.file_path }];
  }

  private _applyReplacement(
    currentContent: string | null,
    oldString: string,
    newString: string,
    isNewFile: boolean,
  ): string {
    if (isNewFile) {
      return newString;
    }
    if (currentContent === null) {
      // Should not happen if not a new file, but defensively return empty or newString if oldString is also empty
      return oldString === '' ? newString : '';
    }
    // If oldString is empty and it's not a new file, do not modify the content.
    if (oldString === '' && !isNewFile) {
      return currentContent;
    }
    return currentContent.replaceAll(oldString, newString);
  }

  /**
   * Applies one or more search-and-replace edits to a string of code.
   * It first attempts a simple, exact-match replacement for all occurrences.
   * If no exact matches are found, it falls back to a "fuzzy" line-by-line match.
   *
   * @param fileContent The source code or text to modify.
   * @param oldString The block of text to find.
   * @param newString The block of text to substitute.
   * @returns An object containing the modified code and the number of replacements made.
   */
  private applyFileEdits(
    fileContent: string,
    oldString: string,
    newString: string,
  ): { modifiedCode: string; occurrences: number } {
    const hadTrailingNewline = fileContent.endsWith('\n');

    // 1. Normalize line endings for consistent processing.
    const normalizedCode = fileContent.replace(/\r\n/g, '\n');
    const normalizedSearch = oldString.replace(/\r\n/g, '\n');
    const normalizedReplace = newString.replace(/\r\n/g, '\n');
    
    if (normalizedSearch === '') {
        return { modifiedCode: fileContent, occurrences: 0 };
    }

    // 2. First attempt: a simple, exact string replacement for ALL occurrences.
    const exactOccurrences = normalizedCode.split(normalizedSearch).length - 1;
    if (exactOccurrences > 0) {
      let modifiedCode = normalizedCode.replaceAll(
        normalizedSearch,
        normalizedReplace,
      );

      // Enforce the original trailing newline state.
      if (hadTrailingNewline && !modifiedCode.endsWith('\n')) {
        modifiedCode += '\n';
      } else if (!hadTrailingNewline && modifiedCode.endsWith('\n')) {
        modifiedCode = modifiedCode.replace(/\n$/, '');
      }
      return { modifiedCode, occurrences: exactOccurrences };
    }

    // 3. Flexible match: Compare line-by-line, ignoring leading/trailing whitespace.
    const sourceLines =
      normalizedCode.match(/.*(?:\n|$)/g)?.slice(0, -1) ?? [];
    const searchLinesStripped = normalizedSearch
      .split('\n')
      .map((line) => line.trim());
    const replaceLines = normalizedReplace.split('\n');

    let flexibleOccurrences = 0;
    let i = 0;
    while (i <= sourceLines.length - searchLinesStripped.length) {
      const window = sourceLines.slice(i, i + searchLinesStripped.length);
      const windowStripped = window.map((line) => line.trim());

      const isMatch = windowStripped.every(
        (line, index) => line === searchLinesStripped[index],
      );

      if (isMatch) {
        flexibleOccurrences++;
        const firstLineInMatch = window[0];
        const indentationMatch = firstLineInMatch.match(/^(\s*)/);
        const indentation = indentationMatch ? indentationMatch[1] : '';
        const newBlockWithIndent = replaceLines.map(
          (line) => `${indentation}${line}`,
        );
        sourceLines.splice(i, searchLinesStripped.length, ...newBlockWithIndent);
        i += replaceLines.length;
      } else {
        i++;
      }
    }

    if (flexibleOccurrences > 0) {
        let modifiedCode = sourceLines.join('');
        if (hadTrailingNewline && !modifiedCode.endsWith('\n')) {
            modifiedCode += '\n';
        } else if (!hadTrailingNewline && modifiedCode.endsWith('\n')) {
            modifiedCode = modifiedCode.replace(/\n$/, '');
        }
        return { modifiedCode, occurrences: flexibleOccurrences };
    }

    // No matches found by either method.
    return { modifiedCode: fileContent, occurrences: 0 };
  }

  /**
   * Calculates the potential outcome of an edit operation.
   * @param params Parameters for the edit operation
   * @returns An object describing the potential edit outcome
   * @throws File system errors if reading the file fails unexpectedly (e.g., permissions)
   */
  private async calculateEdit(
    params: EditToolParams,
    abortSignal: AbortSignal,
  ): Promise<CalculatedEdit> {
    const expectedReplacements = params.expected_replacements ?? 1;
    let currentContent: string | null = null;
    let newContent = ''; // Initialize newContent
    let fileExists = false;
    let isNewFile = false;
    let finalNewString = params.new_string;
    let finalOldString = params.old_string;
    let occurrences = 0;
    let error: { display: string; raw: string } | undefined = undefined;

    try {
      currentContent = fs.readFileSync(params.file_path, 'utf8');
      // Normalize line endings to LF for consistent processing.
      currentContent = currentContent.replace(/\r\n/g, '\n');
      fileExists = true;
    } catch (err: unknown) {
      if (!isNodeError(err) || err.code !== 'ENOENT') {
        // Rethrow unexpected FS errors (permissions, etc.)
        throw err;
      }
      fileExists = false;
    }

    if (params.old_string === '' && !fileExists) {
      // Creating a new file
      isNewFile = true;
      newContent = this._applyReplacement(
        currentContent,
        params.old_string,
        params.new_string,
        isNewFile,
      );
    } else if (!fileExists) {
      // Trying to edit a nonexistent file (and old_string is not empty)
      error = {
        display: `File not found. Cannot apply edit. Use an empty old_string to create a new file.`,
        raw: `File not found: ${params.file_path}`,
      };
    } else if (currentContent !== null) {
      // CHANGED: Added branching logic based on edit_mode.
      if (this.edit_mode === 'fuzzy_search_and_replace') {
        try {
          const fileEditResponse = this.applyFileEdits(
            currentContent,
            params.old_string,
            params.new_string,
          );

          occurrences = fileEditResponse['occurrences'];
          newContent = fileEditResponse['modifiedCode'];
          if (occurrences === 0) {
            error = {
              display: `Failed to edit, could not find the string to replace using fuzzy search.`,
              raw: `Fuzzy search failed: 0 occurrences found for old_string in ${params.file_path}.`,
            };
          } else if (occurrences !== expectedReplacements) {
              const occurrenceTerm =
              expectedReplacements === 1 ? 'occurrence' : 'occurrences';
            error = {
              display: `Failed to edit, expected ${expectedReplacements} ${occurrenceTerm} but fuzzy search found ${occurrences}.`,
              raw: `Failed to edit, Expected ${expectedReplacements} ${occurrenceTerm} but fuzzy search found ${occurrences} for old_string in file: ${params.file_path}`,
            };
          } else if (newContent === currentContent) {
              error = {
                  display: `No changes to apply. The old_string and new_string are identical.`,
                  raw: `No changes to apply. The old_string and new_string are identical in file: ${params.file_path}`,
              };
          }
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          error = {
            display: `Failed to edit, could not find the string to replace.`,
            raw: `Fuzzy search failed: ${errorMessage}`,
          };
        }
      } else {
        // Existing logic for 'search_and_replace' and 'search_and_replace_corrector'
        if (this.edit_mode == 'search_and_replace_corrector') {
          const correctedEdit = await ensureCorrectEdit(
            params.file_path,
            currentContent,
            params,
            this.config.getGeminiClient(),
            abortSignal,
          );
          finalOldString = correctedEdit.params.old_string;
          finalNewString = correctedEdit.params.new_string;
          occurrences = correctedEdit.occurrences;
        } else {
          finalOldString = params.old_string;
          finalNewString = params.new_string;
          occurrences = countOccurrences(currentContent, finalOldString);
        }

        if (params.old_string === '') {
          // Error: Trying to create a file that already exists
          error = {
            display: `Failed to edit. Attempted to create a file that already exists.`,
            raw: `File already exists, cannot create: ${params.file_path}`,
          };
        } else if (occurrences === 0) {
          error = {
            display: `Failed to edit, could not find the string to replace.`,
            raw: `Failed to edit, 0 occurrences found for old_string in ${params.file_path}. No edits made. The exact text in old_string was not found. Ensure you're not escaping content incorrectly and check whitespace, indentation, and context. Use ${ReadFileTool.Name} tool to verify.`,
          };
        } else if (occurrences !== expectedReplacements) {
          const occurrenceTerm =
            expectedReplacements === 1 ? 'occurrence' : 'occurrences';

          error = {
            display: `Failed to edit, expected ${expectedReplacements} ${occurrenceTerm} but found ${occurrences}.`,
            raw: `Failed to edit, Expected ${expectedReplacements} ${occurrenceTerm} but found ${occurrences} for old_string in file: ${params.file_path}`,
          };
        } else if (finalOldString === finalNewString) {
          error = {
            display: `No changes to apply. The old_string and new_string are identical.`,
            raw: `No changes to apply. The old_string and new_string are identical in file: ${params.file_path}`,
          };
        }
        newContent = this._applyReplacement(
          currentContent,
          finalOldString,
          finalNewString,
          isNewFile,
        );
      }
    } else {
      // Should not happen if fileExists and no exception was thrown, but defensively:
      error = {
        display: `Failed to read content of file.`,
        raw: `Failed to read content of existing file: ${params.file_path}`,
      };
    }
    
    // Fallback if newContent was not set (e.g., in an error case)
    if ((newContent === '' || newContent === undefined) && currentContent) {
      newContent = currentContent;
    }
    
    return {
      currentContent,
      newContent,
      occurrences,
      error,
      isNewFile,
    };
  }

  /**
   * Handles the confirmation prompt for the Edit tool in the CLI.
   * It needs to calculate the diff to show the user.
   */
  async shouldConfirmExecute(
    params: EditToolParams,
    abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    if (this.config.getApprovalMode() === ApprovalMode.AUTO_EDIT) {
      return false;
    }
    const validationError = this.validateToolParams(params);
    if (validationError) {
      console.error(
        `[EditTool Wrapper] Attempted confirmation with invalid parameters: ${validationError}`,
      );
      return false;
    }

    let editData: CalculatedEdit;
    try {
      editData = await this.calculateEdit(params, abortSignal);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(`Error preparing edit: ${errorMsg}`);
      return false;
    }

    if (editData.error) {
      console.log(`Error: ${editData.error.display}`);
      return false;
    }

    const fileName = path.basename(params.file_path);
    const fileDiff = Diff.createPatch(
      fileName,
      editData.currentContent ?? '',
      editData.newContent,
      'Current',
      'Proposed',
      DEFAULT_DIFF_OPTIONS,
    );
    const confirmationDetails: ToolEditConfirmationDetails = {
      type: 'edit',
      title: `Confirm Edit: ${shortenPath(makeRelative(params.file_path, this.config.getTargetDir()))}`,
      fileName,
      fileDiff,
      originalContent: editData.currentContent,
      newContent: editData.newContent,
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          this.config.setApprovalMode(ApprovalMode.AUTO_EDIT);
        }
      },
    };
    return confirmationDetails;
  }

  getDescription(params: EditToolParams): string {
    if (!params.file_path || !params.old_string || !params.new_string) {
      return `Model did not provide valid parameters for edit tool`;
    }
    const relativePath = makeRelative(
      params.file_path,
      this.config.getTargetDir(),
    );
    if (params.old_string === '') {
      return `Create ${shortenPath(relativePath)}`;
    }

    const oldStringSnippet =
      params.old_string.split('\n')[0].substring(0, 30) +
      (params.old_string.length > 30 ? '...' : '');
    const newStringSnippet =
      params.new_string.split('\n')[0].substring(0, 30) +
      (params.new_string.length > 30 ? '...' : '');

    if (params.old_string === params.new_string) {
      return `No file changes to ${shortenPath(relativePath)}`;
    }
    return `${shortenPath(relativePath)}: ${oldStringSnippet} => ${newStringSnippet}`;
  }

  /**
   * Executes the edit operation with the given parameters.
   * @param params Parameters for the edit operation
   * @returns Result of the edit operation
   */
  async execute(
    params: EditToolParams,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: Invalid parameters provided. Reason: ${validationError}`,
        returnDisplay: `Error: ${validationError}`,
        error: {
          message: validationError,
          type: 'VALIDATION_ERROR',
        },
      };
    }
    console.log('Executing edit tool');

    let editData: CalculatedEdit;
    try {
      editData = await this.calculateEdit(params, signal);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Error preparing edit: ${errorMsg}`,
        returnDisplay: `Error preparing edit: ${errorMsg}`,
        error: {
          message: errorMsg,
          type: 'EDIT_PREPARATION_ERROR',
        },
      };
    }

    if (editData.error) {
      return {
        llmContent: editData.error.raw,
        returnDisplay: `Error: ${editData.error.display}`,
        error: {
          message: editData.error.raw,
          type: 'EDIT_CALCULATION_ERROR',
        },
      };
    }

    try {
      this.ensureParentDirectoriesExist(params.file_path);
      fs.writeFileSync(params.file_path, editData.newContent, 'utf8');

      let displayResult: ToolResultDisplay;
      if (editData.isNewFile) {
        displayResult = `Created ${shortenPath(makeRelative(params.file_path, this.config.getTargetDir()))}`;
      } else {
        // Generate diff for display, even though core logic doesn't technically need it
        // The CLI wrapper will use this part of the ToolResult
        const fileName = path.basename(params.file_path);
        const fileDiff = Diff.createPatch(
          fileName,
          editData.currentContent ?? '', // Should not be null here if not isNewFile
          editData.newContent,
          'Current',
          'Proposed',
          DEFAULT_DIFF_OPTIONS,
        );
        displayResult = {
          fileDiff,
          fileName,
          originalContent: editData.currentContent,
          newContent: editData.newContent,
        };
      }

      const llmSuccessMessageParts = [
        editData.isNewFile
          ? `Created new file: ${params.file_path} with provided content.`
          : `Successfully modified file: ${params.file_path} (${editData.occurrences} replacements).`,
      ];
      if (params.modified_by_user) {
        llmSuccessMessageParts.push(
          `User modified the \`new_string\` content to be: ${params.new_string}.`,
        );
      }

      return {
        llmContent: llmSuccessMessageParts.join(' '),
        returnDisplay: displayResult,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Error executing edit: ${errorMsg}`,
        returnDisplay: `Error writing file: ${errorMsg}`,
        error: {
          message: errorMsg,
          type: 'FILE_WRITE_ERROR',
        },
      };
    }
  }

  /**
   * Creates parent directories if they don't exist
   */
  private ensureParentDirectoriesExist(filePath: string): void {
    const dirName = path.dirname(filePath);
    if (!fs.existsSync(dirName)) {
      fs.mkdirSync(dirName, { recursive: true });
    }
  }

  getModifyContext(_: AbortSignal): ModifyContext<EditToolParams> {
    return {
      getFilePath: (params: EditToolParams) => params.file_path,
      getCurrentContent: async (params: EditToolParams): Promise<string> => {
        try {
          return fs.readFileSync(params.file_path, 'utf8');
        } catch (err) {
          if (!isNodeError(err) || err.code !== 'ENOENT') throw err;
          return '';
        }
      },
      getProposedContent: async (params: EditToolParams): Promise<string> => {
        try {
          const currentContent = fs.readFileSync(params.file_path, 'utf8');
          return this._applyReplacement(
            currentContent,
            params.old_string,
            params.new_string,
            params.old_string === '' && currentContent === '',
          );
        } catch (err) {
          if (!isNodeError(err) || err.code !== 'ENOENT') throw err;
          return '';
        }
      },
      createUpdatedParams: (
        oldContent: string,
        modifiedProposedContent: string,
        originalParams: EditToolParams,
      ): EditToolParams => ({
        ...originalParams,
        old_string: oldContent,
        new_string: modifiedProposedContent,
        modified_by_user: true,
      }),
    };
  }
}