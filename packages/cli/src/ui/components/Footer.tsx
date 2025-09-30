/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { shortenPath, tildeifyPath , ApprovalMode } from '@google/gemini-cli-core';
import { ConsoleSummaryDisplay } from './ConsoleSummaryDisplay.js';
import process from 'node:process';
import Gradient from 'ink-gradient';
import { MemoryUsageDisplay } from './MemoryUsageDisplay.js';
import { ContextUsageDisplay } from './ContextUsageDisplay.js';
import { DebugProfiler } from './DebugProfiler.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';

import { useUIState } from '../contexts/UIStateContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { useVimMode } from '../contexts/VimModeContext.js';
import { AutoAcceptIndicator } from './AutoAcceptIndicator.js';
import { ShellModeIndicator } from './ShellModeIndicator.js';

export const Footer: React.FC = () => {
  const uiState = useUIState();
  const config = useConfig();
  const settings = useSettings();
  const { vimEnabled, vimMode } = useVimMode();

  const {
    model,
    targetDir,
    debugMode,
    branchName,
    debugMessage,
    corgiMode,
    errorCount,
    showErrorDetails,
    promptTokenCount,
    nightly,
    isTrustedFolder,
    showAutoAcceptIndicator,
    shellModeActive,
  } = {
    model: config.getModel(),
    targetDir: config.getTargetDir(),
    debugMode: config.getDebugMode(),
    branchName: uiState.branchName,
    debugMessage: uiState.debugMessage,
    corgiMode: uiState.corgiMode,
    errorCount: uiState.errorCount,
    showErrorDetails: uiState.showErrorDetails,
    promptTokenCount: uiState.sessionStats.lastPromptTokenCount,
    nightly: uiState.nightly,
    isTrustedFolder: uiState.isTrustedFolder,
    showAutoAcceptIndicator: uiState.showAutoAcceptIndicator,
    shellModeActive: uiState.shellModeActive,
  };

  const showMemoryUsage =
    config.getDebugMode() || settings.merged.ui?.showMemoryUsage || false;
  const hideCWD =
    settings.merged.ui?.footer?.hideCWD || settings.merged.ui?.minimal || false;
  const hideSandboxStatus =
    settings.merged.ui?.footer?.hideSandboxStatus ||
    settings.merged.ui?.minimal ||
    false;
  const hideModelInfo = settings.merged.ui?.footer?.hideModelInfo || false;

  const { columns: terminalWidth } = useTerminalSize();

  const pathLength = Math.max(20, Math.floor(terminalWidth * 0.25));
  const displayPath = shortenPath(tildeifyPath(targetDir), pathLength);

  const justifyContent = hideCWD && hideModelInfo ? 'center' : 'space-between';
  const displayVimMode = vimEnabled ? vimMode : undefined;

  return (
    <Box
      justifyContent={justifyContent}
      width="100%"
      flexDirection="row"
      alignItems="center"
    >
      {(debugMode || displayVimMode || !hideCWD) && (
        <Box>
          {debugMode && <DebugProfiler />}
          {displayVimMode && (
            <Text color={theme.text.secondary}>[{displayVimMode}] </Text>
          )}
          {!hideCWD &&
            (nightly ? (
              <Gradient colors={theme.ui.gradient}>
                <Text>
                  {displayPath}
                  {branchName && <Text> ({branchName}*)</Text>}
                </Text>
              </Gradient>
            ) : (
              <Text color={theme.text.link}>
                {displayPath}
                {branchName && (
                  <Text color={theme.text.secondary}> ({branchName}*)</Text>
                )}
              </Text>
            ))}
          {debugMode && (
            <Text color={theme.status.error}>
              {' ' + (debugMessage || '--debug')}
            </Text>
          )}
        </Box>
      )}

      {/* Middle Section: Centered Trust/Sandbox Info */}
      {!hideSandboxStatus && (
        <Box
          flexGrow={1}
          alignItems="center"
          justifyContent="center"
          display="flex"
        >
          {isTrustedFolder === false ? (
            <Text color={theme.status.warning}>untrusted</Text>
          ) : process.env['SANDBOX'] &&
            process.env['SANDBOX'] !== 'sandbox-exec' ? (
            <Text color="green">
              {process.env['SANDBOX'].replace(/^gemini-(?:cli-)?/, '')}
            </Text>
          ) : process.env['SANDBOX'] === 'sandbox-exec' ? (
            <Text color={theme.status.warning}>
              macOS Seatbelt{' '}
              <Text color={theme.text.secondary}>
                ({process.env['SEATBELT_PROFILE']})
              </Text>
            </Text>
          ) : (
            <Text color={theme.status.error}>
              no sandbox
              {terminalWidth >= 100 && (
                <Text color={theme.text.secondary}> (see /docs)</Text>
              )}
            </Text>
          )}
        </Box>
      )}

      {/* Right Section: Gemini Label and Console Summary */}
      <Box
        alignItems="center"
        justifyContent={
          settings.merged.ui?.minimal ? 'space-between' : 'flex-end'
        }
        flexGrow={1}
      >
        {settings.merged.ui?.minimal && (
          <Box>
            {showAutoAcceptIndicator !== ApprovalMode.DEFAULT &&
              !shellModeActive && (
                <AutoAcceptIndicator approvalMode={showAutoAcceptIndicator} />
              )}
            {shellModeActive && <ShellModeIndicator />}
          </Box>
        )}
        {!hideModelInfo && (
          <Box alignItems="center" justifyContent="flex-end">
            <Box alignItems="center">
              <Text color={theme.text.accent}>
                {model}{' '}
                <ContextUsageDisplay
                  promptTokenCount={promptTokenCount}
                  model={model}
                  terminalWidth={terminalWidth}
                />
              </Text>
              {showMemoryUsage && <MemoryUsageDisplay />}
            </Box>
            <Box alignItems="center" paddingLeft={2}>
              {corgiMode && (
                <Text>
                  <Text color={theme.ui.symbol}>| </Text>
                  <Text color={theme.status.error}>▼</Text>
                  <Text color={theme.text.primary}>(´</Text>
                  <Text color={theme.status.error}>ᴥ</Text>
                  <Text color={theme.text.primary}>`)</Text>
                  <Text color={theme.status.error}>▼ </Text>
                </Text>
              )}
              {!showErrorDetails && errorCount > 0 && (
                <Box>
                  <Text color={theme.ui.symbol}>| </Text>
                  <ConsoleSummaryDisplay errorCount={errorCount} />
                </Box>
              )}
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
};
