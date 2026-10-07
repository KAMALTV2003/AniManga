import { Command } from 'commander';

import {
  checkSkillPromotion,
  composeCapabilities,
  evaluateRetrieval,
  promoteSkillVersion,
  proposeCapability,
  rollbackSkillPromotion,
  searchCapabilities,
  syncCapabilities,
} from './commands/capabilities.js';
import { runDoctor } from './commands/doctor.js';
import { harvestSkill } from './commands/harvest.js';
import { initializeProject } from './commands/init.js';
import { migrateDatabase } from './commands/migrate.js';
import {
  analyzeSkill,
  installSkill,
  searchSkills,
  testSkill,
  verifySkill,
} from './commands/skills.js';
import { getStatus } from './commands/status.js';
import { validateInstallation } from './commands/validate.js';
import { writeError, writeResult, type CliOutput } from './output.js';

export interface ProgramIo {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

function outputFor(command: Command, io: ProgramIo): CliOutput {
  const global = command.optsWithGlobals<{ json?: boolean }>();
  return { ...io, json: global.json === true };
}

function formatDoctor(report: Awaited<ReturnType<typeof runDoctor>>): string {
  const lines = [`NEXUS doctor: ${report.status.toUpperCase()}`];
  for (const check of report.checks) {
    const marker = check.status === 'pass' ? 'PASS' : check.status === 'warn' ? 'WARN' : 'FAIL';
    lines.push(`  [${marker}] ${check.id} — ${check.message}`);
  }
  return lines.join('\n');
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new RangeError('limit must be an integer between 1 and 100');
  }
  return parsed;
}

function parseMaximumNodes(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new RangeError('max-nodes must be an integer between 1 and 20');
  }
  return parsed;
}

function parseContextBytes(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100_000_000) {
    throw new RangeError('max-context-bytes must be an integer between 0 and 100000000');
  }
  return parsed;
}

function parseRequiredSuites(values: readonly string[]) {
  if (values.length < 1 || values.length > 20) {
    throw new RangeError('require-suite must contain between 1 and 20 name@version values');
  }
  return values.map((value) => {
    const separator = value.lastIndexOf('@');
    if (separator < 1 || separator === value.length - 1) {
      throw new RangeError(`evaluation suite must use name@version: ${value}`);
    }
    return { name: value.slice(0, separator), version: value.slice(separator + 1) };
  });
}

const HARVEST_SOURCE_TYPES = [
  'auto',
  'local-directory',
  'zip-archive',
  'https-archive',
  'git-repository',
] as const;

type HarvestSourceOption = (typeof HARVEST_SOURCE_TYPES)[number];

function parseHarvestSourceType(value: string): HarvestSourceOption {
  if (!HARVEST_SOURCE_TYPES.includes(value as HarvestSourceOption)) {
    throw new RangeError(`type must be one of: ${HARVEST_SOURCE_TYPES.join(', ')}`);
  }
  return value as HarvestSourceOption;
}

export function createProgram(
  io: ProgramIo = { stdout: process.stdout, stderr: process.stderr },
): Command {
  const program = new Command();
  program
    .name('nexus')
    .description('NEXUS AI capability operating system')
    .version('0.1.0-dev.1')
    .option('--json', 'emit machine-readable JSON')
    .showSuggestionAfterError()
    .showHelpAfterError();

  program
    .command('init')
    .description('initialize a NEXUS project and local database')
    .argument('[directory]', 'project directory', '.')
    .action(async (directory: string, _options: unknown, command: Command) => {
      const output = outputFor(command, io);
      try {
        const result = await initializeProject(directory);
        writeResult(output, result, () =>
          [
            'NEXUS initialized successfully.',
            `  Project: ${result.projectId}`,
            `  Config: ${result.configPath}`,
            `  Database: ${result.databasePath}`,
            `  Schema: v${result.schemaVersion}`,
          ].join('\n'),
        );
      } catch (error) {
        writeError(output, error);
        process.exitCode = 1;
      }
    });

  program
    .command('doctor')
    .description('diagnose configuration, permissions, and database health')
    .action(async (_options: unknown, command: Command) => {
      const output = outputFor(command, io);
      try {
        const report = await runDoctor(process.cwd());
        writeResult(output, report, () => formatDoctor(report));
        if (report.status === 'unhealthy') process.exitCode = 1;
      } catch (error) {
        writeError(output, error);
        process.exitCode = 1;
      }
    });

  program
    .command('status')
    .description('show NEXUS installation status and object counts')
    .action(async (_options: unknown, command: Command) => {
      const output = outputFor(command, io);
      try {
        const report = await getStatus(process.cwd());
        writeResult(output, report, () =>
          [
            `NEXUS ${report.version} — ${report.status.toUpperCase()}`,
            `  Project: ${report.project.name} (${report.project.id})`,
            `  Environment: ${report.environment}`,
            `  Database schema: v${report.database.schemaVersion}/${report.database.latestSchemaVersion}`,
            `  Objects: skills=${report.counts.skills}, agents=${report.counts.agents}, workflows=${report.counts.workflows}, executions=${report.counts.executions}`,
          ].join('\n'),
        );
      } catch (error) {
        writeError(output, error);
        process.exitCode = 1;
      }
    });

  program
    .command('validate')
    .description('strictly validate configuration and database migrations')
    .action(async (_options: unknown, command: Command) => {
      const output = outputFor(command, io);
      try {
        const report = await validateInstallation(process.cwd());
        writeResult(
          output,
          report,
          () => `NEXUS validation passed (schema v${report.schemaVersion}).`,
        );
      } catch (error) {
        writeError(output, error);
        process.exitCode = 1;
      }
    });

  program
    .command('migrate')
    .description('back up and apply pending checksummed database migrations')
    .action(async (_options: unknown, command: Command) => {
      const output = outputFor(command, io);
      try {
        const report = await migrateDatabase(process.cwd());
        writeResult(output, report, () =>
          report.migrated
            ? [
                `NEXUS database migrated from v${report.fromVersion} to v${report.toVersion}.`,
                `  Applied: ${report.applied.join(', ')}`,
                `  Backup: ${report.backupPath ?? 'none'}`,
              ].join('\n')
            : `NEXUS database is already at schema v${report.toVersion}.`,
        );
      } catch (error) {
        writeError(output, error);
        process.exitCode = 1;
      }
    });

  const capability = program
    .command('capability')
    .description('index, retrieve, compose, and propose typed capabilities');

  capability
    .command('sync')
    .description('synchronize active Skill versions into the capability graph')
    .action(async (_options: unknown, command: Command) => {
      const output = outputFor(command, io);
      try {
        const report = await syncCapabilities(process.cwd());
        writeResult(output, report, () =>
          [
            `Capability graph synchronized for ${report.projectId}.`,
            `  Skills indexed: ${report.indexedSkills}`,
            `  Dependency edges: ${report.dependencyEdges}`,
            `  Unresolved dependency owners: ${Object.keys(report.unresolvedDependencies).length}`,
          ].join('\n'),
        );
      } catch (error) {
        writeError(output, error);
        process.exitCode = 1;
      }
    });

  capability
    .command('search')
    .description('run bounded lexical, metadata, and graph capability retrieval')
    .argument('<query>', 'capability intent query')
    .option('-l, --limit <count>', 'maximum results (1-100)', parsePositiveInteger, 10)
    .option('--tag <tags...>', 'preferred metadata tags')
    .action(async (query: string, options: { limit: number; tag?: string[] }, command: Command) => {
      const output = outputFor(command, io);
      try {
        const report = await searchCapabilities(process.cwd(), query, {
          limit: options.limit,
          ...(options.tag === undefined ? {} : { tags: options.tag }),
        });
        writeResult(output, report, () =>
          report.results.length === 0
            ? 'No active capabilities matched.'
            : [
                `Capability retrieval ${report.runId} (${report.strategyVersion}):`,
                ...report.results.map(
                  (item) =>
                    `  ${item.name} (${item.nodeId}) score=${item.score.toFixed(4)} — ${item.explanation.join(', ')}`,
                ),
              ].join('\n'),
        );
      } catch (error) {
        writeError(output, error);
        process.exitCode = 1;
      }
    });

  capability
    .command('compose')
    .description('select a bounded smallest sufficient capability bundle')
    .argument('<query>', 'task or intent query')
    .requiredOption('--require <behaviors...>', 'required capability behaviors')
    .option('--max-nodes <count>', 'maximum unique nodes (1-20)', parseMaximumNodes, 10)
    .option(
      '--max-context-bytes <bytes>',
      'maximum aggregate context bytes',
      parseContextBytes,
      1_000_000,
    )
    .action(
      async (
        query: string,
        options: { require: string[]; maxNodes: number; maxContextBytes: number },
        command: Command,
      ) => {
        const output = outputFor(command, io);
        try {
          const report = await composeCapabilities(process.cwd(), query, {
            requirements: options.require,
            maxNodes: options.maxNodes,
            maxContextBytes: options.maxContextBytes,
          });
          writeResult(output, report, () =>
            [
              `Capability composition: ${report.status.toUpperCase()} (${report.solverMode})`,
              `  Plan: ${report.planId}`,
              `  Selected: ${report.selected.map((item) => item.name).join(', ') || 'none'}`,
              `  Context bytes: ${report.contextBytes}`,
              `  Uncovered: ${report.uncoveredCapabilities.join(', ') || 'none'}`,
            ].join('\n'),
          );
          if (report.status === 'incomplete') process.exitCode = 2;
        } catch (error) {
          writeError(output, error);
          process.exitCode = 1;
        }
      },
    );

  capability
    .command('propose')
    .description('persist an inert synthesis contract for measured composition gaps')
    .argument('<query>', 'task or intent query')
    .requiredOption('--name <name>', 'proposed capability name')
    .requiredOption('--require <behaviors...>', 'required capability behaviors')
    .requiredOption('--accept <criteria...>', 'deterministic acceptance criteria')
    .option('--prohibit <behaviors...>', 'explicitly prohibited behaviors')
    .action(
      async (
        query: string,
        options: {
          name: string;
          require: string[];
          accept: string[];
          prohibit?: string[];
        },
        command: Command,
      ) => {
        const output = outputFor(command, io);
        try {
          const report = await proposeCapability(process.cwd(), query, {
            name: options.name,
            requirements: options.require,
            acceptanceCriteria: options.accept,
            ...(options.prohibit === undefined ? {} : { prohibitedBehaviors: options.prohibit }),
          });
          writeResult(output, report, () =>
            [
              `Synthesis proposal created: ${report.proposal.id}`,
              `  Status: ${report.proposal.status}`,
              `  Evidence plan: ${report.proposal.compositionPlanId}`,
              `  Required behaviors: ${report.proposal.requiredBehaviors.join(', ')}`,
              '  Generated executable content: no',
            ].join('\n'),
          );
        } catch (error) {
          writeError(output, error);
          process.exitCode = 1;
        }
      },
    );

  capability
    .command('evaluate')
    .description('run and persist a versioned retrieval suite against the lexical baseline')
    .argument('<suite>', 'bounded JSON retrieval evaluation suite')
    .action(async (suite: string, _options: unknown, command: Command) => {
      const output = outputFor(command, io);
      try {
        const report = await evaluateRetrieval(process.cwd(), suite);
        writeResult(output, report, () =>
          [
            `Retrieval evaluation: ${report.status.toUpperCase()}`,
            `  Run: ${report.runId}`,
            `  Suite: ${report.suiteName}@${report.suiteVersion}`,
            `  Baseline recall@${report.topK}: ${report.baseline.recallAtK}`,
            `  Candidate recall@${report.topK}: ${report.candidate.recallAtK}`,
            `  Recall delta: ${report.delta.recallAtK}`,
          ].join('\n'),
        );
        if (report.status === 'failed') process.exitCode = 2;
      } catch (error) {
        writeError(output, error);
        process.exitCode = 1;
      }
    });

  const skill = program
    .command('skill')
    .description('analyze and manage inert, versioned Skill packages');

  skill
    .command('promotion-check')
    .description('evaluate immutable trust and behavioral evidence without changing registry state')
    .argument('<skill-id>', 'candidate Skill identity')
    .requiredOption('--version <semver>', 'candidate semantic version')
    .option('--require-suite <suite...>', 'required evaluation suite as name@version', [
      'nexus.behavioral-skill@1',
    ])
    .action(
      async (
        skillId: string,
        options: { version: string; requireSuite: string[] },
        command: Command,
      ) => {
        const output = outputFor(command, io);
        try {
          const report = await checkSkillPromotion(
            process.cwd(),
            skillId,
            options.version,
            parseRequiredSuites(options.requireSuite),
          );
          writeResult(output, report, () =>
            [
              `Skill promotion check: ${report.eligible ? 'ELIGIBLE' : 'BLOCKED'}`,
              ...report.checks.map(
                (item) => `  [${item.passed ? 'PASS' : 'FAIL'}] ${item.id} — ${item.summary}`,
              ),
            ].join('\n'),
          );
          if (!report.eligible) process.exitCode = 2;
        } catch (error) {
          writeError(output, error);
          process.exitCode = 1;
        }
      },
    );

  skill
    .command('promote')
    .description('apply an evidence-gated local candidate promotion and record an audit decision')
    .argument('<skill-id>', 'candidate Skill identity')
    .requiredOption('--version <semver>', 'candidate semantic version')
    .requiredOption('--actor <identity>', 'local operator identity declaration')
    .requiredOption('--reason <text>', 'promotion rationale')
    .requiredOption(
      '--acknowledge-local-operator',
      'acknowledge that this local mode does not authenticate the declared actor',
    )
    .option('--require-suite <suite...>', 'required evaluation suite as name@version', [
      'nexus.behavioral-skill@1',
    ])
    .action(
      async (
        skillId: string,
        options: {
          version: string;
          actor: string;
          reason: string;
          acknowledgeLocalOperator: boolean;
          requireSuite: string[];
        },
        command: Command,
      ) => {
        const output = outputFor(command, io);
        try {
          const report = await promoteSkillVersion(process.cwd(), skillId, options.version, {
            actor: options.actor,
            reason: options.reason,
            acknowledgeLocalOperator: options.acknowledgeLocalOperator,
            requiredSuites: parseRequiredSuites(options.requireSuite),
          });
          writeResult(output, report, () =>
            [
              `Skill promotion: ${report.outcome.toUpperCase()}`,
              `  Decision: ${report.id}`,
              `  Version: ${report.skillVersionId}`,
              `  Graph synchronized: ${report.graphSynchronized ? 'yes' : 'no'}`,
              ...report.checks
                .filter((item) => !item.passed)
                .map((item) => `  [FAIL] ${item.id} — ${item.summary}`),
            ].join('\n'),
          );
          if (report.outcome === 'denied') process.exitCode = 2;
        } catch (error) {
          writeError(output, error);
          process.exitCode = 1;
        }
      },
    );

  skill
    .command('rollback-promotion')
    .description('restore the exact registry state preceding an applied promotion')
    .argument('<decision-id>', 'applied promotion decision ID')
    .requiredOption('--actor <identity>', 'local operator identity declaration')
    .requiredOption('--reason <text>', 'rollback rationale')
    .requiredOption(
      '--acknowledge-local-operator',
      'acknowledge that this local mode does not authenticate the declared actor',
    )
    .action(
      async (
        decisionId: string,
        options: {
          actor: string;
          reason: string;
          acknowledgeLocalOperator: boolean;
        },
        command: Command,
      ) => {
        const output = outputFor(command, io);
        try {
          const report = await rollbackSkillPromotion(process.cwd(), decisionId, {
            actor: options.actor,
            reason: options.reason,
            acknowledgeLocalOperator: options.acknowledgeLocalOperator,
          });
          writeResult(output, report, () =>
            [
              `Skill promotion rollback: ${report.outcome.toUpperCase()}`,
              `  Decision: ${report.id}`,
              `  Restored version: ${report.resultingVersionId ?? 'none'}`,
              `  Restored status: ${report.resultingStatus}`,
            ].join('\n'),
          );
        } catch (error) {
          writeError(output, error);
          process.exitCode = 1;
        }
      },
    );

  skill
    .command('harvest')
    .description('acquire, scan, assess, quarantine, or candidate-register an untrusted Skill')
    .argument('<source>', 'local path, HTTPS ZIP URL, or HTTPS Git repository')
    .option(
      '--type <type>',
      'source type (auto, local-directory, zip-archive, https-archive, git-repository)',
      parseHarvestSourceType,
      'auto',
    )
    .option('--ref <ref>', 'Git branch or tag to acquire')
    .option('--skill-path <path>', 'Skill directory when a Git repository contains multiple Skills')
    .option('--allow-host <hosts...>', 'exact remote hostname allowlist')
    .option('--register', 'candidate-register if policy permits; quarantine otherwise', false)
    .option('--inspect-only', 'scan and assess without retaining or registering payloads', false)
    .option('--version <semver>', 'canonical semantic version when not declared')
    .option('--author <name>', 'author declaration when not declared')
    .action(
      async (
        source: string,
        options: {
          type: HarvestSourceOption;
          ref?: string;
          skillPath?: string;
          allowHost?: string[];
          register: boolean;
          inspectOnly: boolean;
          version?: string;
          author?: string;
        },
        command: Command,
      ) => {
        const output = outputFor(command, io);
        try {
          const report = await harvestSkill(process.cwd(), {
            source,
            type: options.type,
            register: options.register,
            inspectOnly: options.inspectOnly,
            ...(options.ref === undefined ? {} : { ref: options.ref }),
            ...(options.skillPath === undefined ? {} : { skillPath: options.skillPath }),
            ...(options.allowHost === undefined ? {} : { allowedHosts: options.allowHost }),
            ...(options.version === undefined ? {} : { version: options.version }),
            ...(options.author === undefined ? {} : { author: options.author }),
          });
          writeResult(output, report, () =>
            [
              `Skill harvest: ${report.status.toUpperCase()}`,
              `  Skill: ${report.skillName}`,
              `  Source snapshot: ${report.sourceSnapshotSha256}`,
              `  Content hash: ${report.contentHash}`,
              `  Risk: ${report.risk}`,
              `  Findings: ${report.findings.length}`,
              `  License: ${report.license.status}${report.license.reviewRequired ? ' (review required)' : ''}`,
              `  Disposition: ${report.assessment.disposition}`,
              `  Duplicates proposed: ${report.duplicates.length}`,
              `  Registration: ${report.registration?.skillId ?? 'none'}`,
              `  Quarantine: ${report.quarantinePath ?? 'none'}`,
              '  Imported code executed: no',
            ].join('\n'),
          );
          if (report.status === 'quarantined') process.exitCode = 2;
        } catch (error) {
          writeError(output, error);
          process.exitCode = 1;
        }
      },
    );

  skill
    .command('analyze')
    .description('parse, inventory, and hash a local Skill directory or ZIP without executing code')
    .argument('<source>', 'Skill directory or ZIP path')
    .action(async (source: string, _options: unknown, command: Command) => {
      const output = outputFor(command, io);
      try {
        const report = await analyzeSkill(process.cwd(), source);
        writeResult(output, report, () => {
          const issueLines = report.issues.map(
            (issue) => `  [${issue.severity.toUpperCase()}] ${issue.code} — ${issue.message}`,
          );
          return [
            `Skill analysis: ${report.valid ? 'VALID' : 'INVALID'}`,
            `  Name: ${report.frontmatter?.name ?? 'unavailable'}`,
            `  Content hash: ${report.contentHash ?? 'unavailable'}`,
            `  Payload: ${report.inventory.length} files, ${report.totalBytes} bytes`,
            `  Imported code executed: no`,
            ...issueLines,
          ].join('\n');
        });
        if (!report.valid) process.exitCode = 1;
      } catch (error) {
        writeError(output, error);
        process.exitCode = 1;
      }
    });

  skill
    .command('test')
    .description('run deterministic structural and integrity tests without executing imported code')
    .argument('<source>', 'Skill directory or ZIP path')
    .action(async (source: string, _options: unknown, command: Command) => {
      const output = outputFor(command, io);
      try {
        const report = await testSkill(process.cwd(), source);
        writeResult(output, report, () =>
          [
            `Skill structural tests: ${report.passed ? 'PASS' : 'FAIL'}`,
            ...report.cases.map(
              (item) => `  [${item.passed ? 'PASS' : 'FAIL'}] ${item.id} — ${item.actual}`,
            ),
            '  Imported code executed: no',
          ].join('\n'),
        );
        if (!report.passed) process.exitCode = 1;
      } catch (error) {
        writeError(output, error);
        process.exitCode = 1;
      }
    });

  skill
    .command('install')
    .alias('register')
    .description('register explicitly trusted local authoring input without the harvest trust gate')
    .argument('<source>', 'operator-authored local Skill directory or ZIP path')
    .requiredOption(
      '--trusted-local-authoring',
      'confirm this is operator-authored local input; use skill harvest for untrusted sources',
    )
    .option('--version <semver>', 'canonical semantic version when not declared by the package')
    .option('--author <name>', 'author declaration when not declared by the package')
    .option('--source-commit <commit>', 'immutable source commit or revision')
    .option('--changelog <text>', 'version changelog')
    .action(
      async (
        source: string,
        options: {
          version?: string;
          author?: string;
          sourceCommit?: string;
          changelog?: string;
        },
        command: Command,
      ) => {
        const output = outputFor(command, io);
        try {
          const installOptions = {
            ...(options.version === undefined ? {} : { version: options.version }),
            ...(options.author === undefined ? {} : { author: options.author }),
            ...(options.sourceCommit === undefined ? {} : { sourceCommit: options.sourceCommit }),
            ...(options.changelog === undefined ? {} : { changelog: options.changelog }),
          };
          const report = await installSkill(process.cwd(), source, installOptions);
          writeResult(output, report, () =>
            [
              `Skill ${report.metadata.name}@${report.version} ${report.installed ? 'installed' : 'already installed'}.`,
              `  ID: ${report.skillId}`,
              `  Content hash: ${report.metadata.contentHash}`,
              `  Artifact: ${report.artifactPath}`,
              '  Imported code executed: no',
            ].join('\n'),
          );
        } catch (error) {
          writeError(output, error);
          process.exitCode = 1;
        }
      },
    );

  skill
    .command('search')
    .description('search registered Skills by indexed name and description')
    .argument('<query>', 'keyword query')
    .option('-l, --limit <count>', 'maximum results (1-100)', parsePositiveInteger, 20)
    .action(async (query: string, options: { limit: number }, command: Command) => {
      const output = outputFor(command, io);
      try {
        const report = await searchSkills(process.cwd(), query, options.limit);
        writeResult(output, report, () =>
          report.length === 0
            ? 'No registered Skills matched.'
            : report
                .map(
                  (item) =>
                    `${item.name}@${item.version} (${item.id}) — ${item.description} [risk=${item.risk}]`,
                )
                .join('\n'),
        );
      } catch (error) {
        writeError(output, error);
        process.exitCode = 1;
      }
    });

  skill
    .command('verify')
    .description('re-hash and structurally verify an installed Skill version')
    .argument('<skill-id>', 'registered Skill ID')
    .option('--version <semver>', 'specific version; defaults to the current version')
    .action(async (skillId: string, options: { version?: string }, command: Command) => {
      const output = outputFor(command, io);
      try {
        const report = await verifySkill(process.cwd(), skillId, options.version);
        writeResult(
          output,
          report,
          () =>
            `Installed Skill verification ${report.structuralTests.passed ? 'passed' : 'failed'} (${report.analysis.contentHash ?? 'no hash'}).`,
        );
        if (!report.structuralTests.passed) process.exitCode = 1;
      } catch (error) {
        writeError(output, error);
        process.exitCode = 1;
      }
    });

  return program;
}
