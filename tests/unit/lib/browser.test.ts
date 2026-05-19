/*
 * SonarQube CLI
 * Copyright (C) SonarSource Sàrl
 * mailto:info AT sonarsource DOT com
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';

const childProcess = await import('node:child_process');
const nodeOs = await import('node:os');

let mockedPlatform: NodeJS.Platform = 'linux';

interface MockProc {
  unrefCalled: boolean;
  on(event: 'error' | 'exit', cb: (value?: Error) => void): void;
  unref(): void;
  emitError(error: Error): void;
  emitExit(): void;
}

let lastProc: MockProc | undefined;

function createProc(): MockProc {
  const listeners: { error?: (error?: Error) => void; exit?: () => void } = {};
  return {
    unrefCalled: false,
    on(event: 'error' | 'exit', cb: (value?: Error) => void) {
      if (event === 'error') {
        listeners.error = cb;
      } else {
        listeners.exit = cb as () => void;
      }
    },
    unref() {
      this.unrefCalled = true;
    },
    emitError(error: Error) {
      listeners.error?.(error);
    },
    emitExit() {
      listeners.exit?.();
    },
  };
}

const spawnMock = mock(() => {
  lastProc = createProc();
  return lastProc;
});

// eslint-disable-next-line @typescript-eslint/no-floating-promises
void mock.module('node:os', () => ({
  ...nodeOs,
  platform: () => mockedPlatform,
}));

// eslint-disable-next-line @typescript-eslint/no-floating-promises
void mock.module('node:child_process', () => ({
  ...childProcess,
  spawn: spawnMock as unknown as typeof childProcess.spawn,
}));

const { openBrowser } = await import('../../../src/lib/browser.js');

describe('openBrowser', () => {
  beforeEach(() => {
    spawnMock.mockClear();
    lastProc = undefined;
  });

  it('uses open on macOS', async () => {
    mockedPlatform = 'darwin';

    const result = openBrowser('https://example.com');

    expect(spawnMock).toHaveBeenCalledWith('open', ['https://example.com'], {
      stdio: 'ignore',
      detached: true,
      shell: false,
    });
    expect(lastProc?.unrefCalled).toBe(true);
    lastProc?.emitExit();
    await expect(result).resolves.toBeUndefined();
  });

  it('uses rundll32 on Windows', async () => {
    mockedPlatform = 'win32';

    const result = openBrowser('https://example.com');

    expect(spawnMock).toHaveBeenCalledWith(
      'rundll32',
      ['url.dll,FileProtocolHandler', 'https://example.com'],
      {
        stdio: 'ignore',
        detached: true,
        shell: false,
      },
    );
    lastProc?.emitExit();
    await expect(result).resolves.toBeUndefined();
  });

  it('uses xdg-open on linux and other platforms', async () => {
    mockedPlatform = 'linux';

    const result = openBrowser('https://example.com');

    expect(spawnMock).toHaveBeenCalledWith('xdg-open', ['https://example.com'], {
      stdio: 'ignore',
      detached: true,
      shell: false,
    });
    lastProc?.emitExit();
    await expect(result).resolves.toBeUndefined();
  });

  it('returns a clear message when command is not found', async () => {
    mockedPlatform = 'linux';
    const result = openBrowser('https://example.com');

    const error = new Error('missing') as Error & { code: string };
    error.code = 'ENOENT';
    lastProc?.emitError(error);

    await expect(result).rejects.toThrow('xdg-open not found on this system');
  });

  it('rejects with the original spawn error for non-ENOENT failures', async () => {
    mockedPlatform = 'darwin';
    const result = openBrowser('https://example.com');

    const error = new Error('permission denied') as Error & { code: string };
    error.code = 'EACCES';
    lastProc?.emitError(error);

    await expect(result).rejects.toBe(error);
  });
});
