/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingsModal } from './SettingsModal';

// Mock child components and global APIs
vi.mock('./McpServerManager', () => ({
  McpServerManager: vi.fn(({ mcpServers, onChange }) => (
    <div data-testid="mcp-server-manager">
      <button onClick={() => onChange({ ...mcpServers, new: {} })}>
        Update Servers
      </button>
    </div>
  )),
}));

const mockSettingsGet = vi.fn();
const mockSettingsSet = vi.fn();
const mockThemesGet = vi.fn();

describe('SettingsModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock the global electron API by attaching it to the existing window
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).electron = {
      settings: {
        get: mockSettingsGet,
        set: mockSettingsSet,
      },
      themes: {
        get: mockThemesGet,
      },
    };

    // Provide default mock implementations
    mockSettingsGet.mockResolvedValue({
      merged: {
        theme: 'Default Dark',
        vimMode: false,
        mcpServers: {},
      },
    });
    mockThemesGet.mockResolvedValue([
      { name: 'Default Dark' },
      { name: 'Default Light' },
    ]);
  });

  it('does not render when isOpen is false', () => {
    const { container } = render(
      <SettingsModal isOpen={false} onClose={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders when isOpen is true and fetches initial data', async () => {
    const { container } = render(
      <SettingsModal isOpen={true} onClose={() => {}} />,
    );

    await waitFor(() => {
      expect(mockSettingsGet).toHaveBeenCalledTimes(1);
      expect(mockThemesGet).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByText('Settings')).toBeInTheDocument();
    const sidebar = container.querySelector('.settings-sidebar');
    expect(
      sidebar?.querySelector('.active')?.textContent,
    ).toBe('Appearance');
  });

  it('calls onClose when the close button is clicked', () => {
    const handleClose = vi.fn();
    render(<SettingsModal isOpen={true} onClose={handleClose} />);
    fireEvent.click(screen.getByText('Close'));
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('switches categories when a sidebar item is clicked', () => {
    const { container } = render(
      <SettingsModal isOpen={true} onClose={() => {}} />,
    );
    const sidebar = container.querySelector('.settings-sidebar');
    expect(sidebar?.querySelector('.active')?.textContent).toBe('Appearance');

    fireEvent.click(screen.getByText('Behavior'));

    expect(sidebar?.querySelector('.active')?.textContent).toBe('Behavior');
    expect(
      screen.queryByText('Appearance', { selector: 'li.active' }),
    ).toBeNull();
  });

  it('handles changing a checkbox setting', async () => {
    mockSettingsGet.mockResolvedValue({ merged: { vimMode: false } });
    render(<SettingsModal isOpen={true} onClose={() => {}} />);

    // Switch to behavior to find the vimMode setting
    fireEvent.click(screen.getByText('Behavior'));

    const vimCheckbox = await screen.findByLabelText('Vim Mode');
    expect(vimCheckbox).not.toBeChecked();

    fireEvent.click(vimCheckbox);

    expect(vimCheckbox).toBeChecked();
    await waitFor(() => {
      expect(mockSettingsSet).toHaveBeenCalledWith({
        changes: { vimMode: true },
        scope: 'User',
      });
    });
  });

  it('handles changing a text input setting', async () => {
    mockSettingsGet.mockResolvedValue({ merged: { preferredEditor: 'code' } });
    render(<SettingsModal isOpen={true} onClose={() => {}} />);

    fireEvent.click(screen.getByText('Behavior'));

    const editorInput = await screen.findByLabelText('Preferred Editor');
    fireEvent.change(editorInput, { target: { value: 'vim' } });

    expect(editorInput).toHaveValue('vim');
    await waitFor(() => {
      expect(mockSettingsSet).toHaveBeenCalledWith({
        changes: { preferredEditor: 'vim' },
        scope: 'User',
      });
    });
  });

  it('handles changing a select setting', async () => {
    mockSettingsGet.mockResolvedValue({
      merged: { memoryImportFormat: 'tree' },
    });
    render(<SettingsModal isOpen={true} onClose={() => {}} />);

    fireEvent.click(screen.getByText('Behavior'));

    const formatSelect = await screen.findByLabelText('Memory Import Format');
    fireEvent.change(formatSelect, { target: { value: 'flat' } });

    expect(formatSelect).toHaveValue('flat');
    await waitFor(() => {
      expect(mockSettingsSet).toHaveBeenCalledWith({
        changes: { memoryImportFormat: 'flat' },
        scope: 'User',
      });
    });
  });

  it('renders McpServerManager and handles changes', async () => {
    render(<SettingsModal isOpen={true} onClose={() => {}} />);

    fireEvent.click(screen.getByText('MCP Servers'));

    const manager = await screen.findByTestId('mcp-server-manager');
    expect(manager).toBeInTheDocument();

    // Simulate a change from the child component
    fireEvent.click(screen.getByText('Update Servers'));

    await waitFor(() => {
      expect(mockSettingsSet).toHaveBeenCalledWith({
        changes: { mcpServers: { new: {} } },
        scope: 'User',
      });
    });
  });
});
