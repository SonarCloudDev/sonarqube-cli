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

import type { Command } from 'commander';

import type { ResolvedAuth } from '../../../lib/auth-resolver';
import {
  blank,
  getMessagesForFormattedOutput,
  print,
  setFormattedOutputMode,
  text,
} from '../../../ui';
import { resolveSecretsBinaryPath } from '../_common/install/secrets';
import { analyzeSecrets, EXIT_CODE_SECRETS_FOUND, runSecretsBinary } from './secrets';
import type { SecretsIssue } from './secrets-output';
import { parseSecretsOutput } from './secrets-output';
import type { OutputFormat } from './sqaa';
import { analyzeSqaa, buildSqaaJsonReport } from './sqaa';
import { resolveChangeSet } from './sqaa-changeset';
import { applyExitCode, makeReport, type SqaaJsonReport } from './sqaa-display';

export interface AnalyzeAllOptions {
  file?: string;
  staged?: boolean;
  base?: string;
  force?: boolean;
  format?: OutputFormat;
}

interface SecretsReport {
  issues: SecretsIssue[];
  summary: { totalIssues: number };
}

function secretsReport(issues: SecretsIssue[]): SecretsReport {
  return { issues, summary: { totalIssues: issues.length } };
}

function printCombinedReport(secrets: SecretsReport | null, agentic: SqaaJsonReport | null): void {
  print(JSON.stringify({ secrets, agentic, messages: getMessagesForFormattedOutput() }, null, 2));
}

/**
 * Run all available analyses sequentially: secrets scan first, then agentic analysis.
 * Fail-fast: if secrets fails the agentic step is skipped.
 *
 * In json mode, outputs a single combined JSON report including any informational messages.
 * In text mode, each analysis prints its own output sequentially.
 */
export async function analyzeAll(
  options: AnalyzeAllOptions,
  auth: ResolvedAuth,
  command?: Command,
): Promise<void> {
  if (options.format === 'json') {
    return analyzeAllJson(options, auth, command);
  }

  const { file, staged, base, force, format } = options;

  if (file !== undefined) {
    await analyzeSecrets({ paths: [file] }, auth);
    await analyzeSqaa({ file, format }, auth, command);
    return;
  }

  const changeSet = await resolveChangeSet(process.cwd(), { staged, base });

  if (changeSet.files.length === 0) {
    blank();
    text('SonarQube Analysis: no files in the change set to analyze.');
    return;
  }

  await analyzeSecrets({ paths: changeSet.files }, auth);
  await analyzeSqaa({ staged, base, force, format }, auth, command);
}

async function analyzeAllJson(
  options: AnalyzeAllOptions,
  auth: ResolvedAuth,
  command?: Command,
): Promise<void> {
  setFormattedOutputMode(true);
  try {
    const { file, staged, base } = options;
    const files = file === undefined ? await resolveChangeSetFiles(staged, base) : [file];

    if (files.length === 0) {
      printCombinedReport(secretsReport([]), makeReport([], []));
      return;
    }

    await runSecretsAndAgentic(files, options, auth, command);
  } finally {
    setFormattedOutputMode(false);
  }
}

async function runSecretsAndAgentic(
  files: string[],
  options: AnalyzeAllOptions,
  auth: ResolvedAuth,
  command?: Command,
): Promise<void> {
  const binaryPath = resolveSecretsBinaryPath();
  if (binaryPath === null) {
    const agenticReport = await buildSqaaJsonReport(options, auth, command);
    printCombinedReport(null, agenticReport);
    if (agenticReport) {
      applyExitCode(agenticReport.summary.totalIssues, agenticReport.summary.totalFailures);
    }
    return;
  }

  const secretsResult = await runSecretsBinary(binaryPath, files, auth);
  const secretsIssues = parseSecretsOutput(secretsResult.stdout);

  if (secretsResult.exitCode !== 0) {
    printCombinedReport(secretsReport(secretsIssues), null);
    process.exitCode = secretsResult.exitCode ?? EXIT_CODE_SECRETS_FOUND;
    return;
  }

  const agenticReport = await buildSqaaJsonReport(options, auth, command);
  printCombinedReport(secretsReport([]), agenticReport);

  if (agenticReport) {
    applyExitCode(agenticReport.summary.totalIssues, agenticReport.summary.totalFailures);
  }
}

async function resolveChangeSetFiles(staged?: boolean, base?: string): Promise<string[]> {
  const changeSet = await resolveChangeSet(process.cwd(), { staged, base });
  return changeSet.files;
}
