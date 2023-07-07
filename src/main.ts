/* eslint-disable camelcase */

import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import {issueCommand} from '@actions/core/lib/command'
import {Octokit, RestEndpointMethodTypes} from '@octokit/action'
import {wrap} from './wrap'

type ChecksCreateResponse =
  RestEndpointMethodTypes['checks']['create']['response']
type ChecksUpdateResponse =
  RestEndpointMethodTypes['checks']['update']['response']

const octokit = new Octokit()
const {owner, repo} = github.context.repo

const head_sha =
  github.context.payload.pull_request?.head?.sha || github.context.sha

function detectFork(): boolean {
  const payload = github.context.payload
  if (payload.pull_request) {
    return (
      payload.pull_request?.head?.repo?.full_name !==
      payload.repository?.full_name
    )
  }
  return false
}

const checkName = core.getInput('name', {required: true})
const checkMessageWrap = 80

const inputElmReview = core.getInput('elm_review', {required: true})
const inputElmReviewConfig = core.getInput('elm_review_config')
const inputElmCompiler = core.getInput('elm_compiler')
const inputElmFormat = core.getInput('elm_format')
const inputElmJson = core.getInput('elm_json')
const inputElmFiles = core.getInput('elm_files')
const inputIgnoreDirs = core.getInput('ignore_dirs')

const workingDirectory = core.getInput('working-directory')

const elmReviewArgs = (): string[] => {
  const arg = (flag: string, value: string): string[] => {
    if (value === '') {
      return []
    }
    return [flag, value]
  }

  const globFiles = (pattern: string): string[] => {
    if (pattern === '') {
      return []
    }
    return pattern.split('\n')
  }

  return [
    ...globFiles(inputElmFiles),
    '--report=json',
    ...arg('--config', inputElmReviewConfig),
    ...arg('--compiler', inputElmCompiler),
    ...arg('--elm-format-path', inputElmFormat),
    ...arg('--elmjson', inputElmJson),
    ...arg('--ignore-dirs', globFiles(inputIgnoreDirs).join(' ')),
  ]
}

const runElmReview = async (): Promise<ReviewErrors | CliError> => {
  let output = ''
  let errput = ''

  const options = {
    cwd: workingDirectory,
    ignoreReturnCode: true,
    listeners: {
      stdout: (data: Buffer) => {
        output += data.toString()
      },
      stderr: (data: Buffer) => {
        errput += data.toString()
      }
    },
    silent: true
  }

  await exec.exec(inputElmReview, elmReviewArgs(), options)

  if (errput.length > 0) {
    throw Error(errput)
  }

  try {
    return JSON.parse(output)
  } catch (_) {
    throw Error(output)
  }
}

type ReviewErrors = {
  type: 'review-errors'
  errors: ReviewError[]
}

type ReviewError = {
  path: string
  errors: ReviewMessage[]
}

type ReviewMessage = {
  message: string
  rule: string
  details: string[]
  region: Region
}

type Region = {
  start: Location
  end: Location
}

type Location = {
  line: number
  column: number
}

type OctokitAnnotation = {
  path: string
  start_line: number
  start_column?: number
  end_line: number
  end_column?: number
  annotation_level: 'notice' | 'warning' | 'failure'
  message: string
  title?: string
  raw_details?: string
}

const reportErrors = (errors: ReviewErrors): OctokitAnnotation[] => {
  return errors.errors.flatMap((error: ReviewError) => {
    return error.errors.map((message: ReviewMessage): OctokitAnnotation => {
      const annotation: OctokitAnnotation = {
        path: error.path,
        annotation_level: 'failure',
        start_line: message.region.start.line,
        end_line: message.region.end.line,
        title: `${message.rule}: ${message.message}`,
        message: wrap(checkMessageWrap, message.details.join('\n\n'))
      }

      if (message.region.start.line === message.region.end.line) {
        annotation.start_column = message.region.start.column
        annotation.end_column = message.region.end.column
      }

      return annotation
    })
  })
}

type CliError = {
  type: 'error'
  title: string
  path: string
  message: string | string[]
}

type UnexpectedError = {
  title: string
  path: string
  error: string
}

type ErrorOpts = {
  file?: string
  line?: number
  col?: number
}

function issueError(message: string, opts: ErrorOpts): void {
  for (const line of message.trim().split('\n')) {
    issueCommand('error', opts, line)
  }
  process.exitCode = core.ExitCode.Failure
}

function messageString(message: string | string[]): string {
  // Sometimes elm-review returns an array of message (usually just one message)
  return Array(message).join('\n')
}

function reportCliError(error: Error | CliError | UnexpectedError): void {
  let message: string
  if ('message' in error) {
    message = messageString(error.message)
  } else {
    message = error.error
  }

  const opts: ErrorOpts = {}
  if ('path' in error) {
    opts.file = error.path
  }

  issueError(message, opts)
}

async function createCheckSuccess(): Promise<ChecksCreateResponse> {
  return octokit.rest.checks.create({
    owner,
    repo,
    name: checkName,
    head_sha,
    status: 'completed',
    conclusion: 'success',
    output: {
      title: 'No problems to report',
      summary: 'I found no problems while reviewing!'
    }
  })
}

async function updateCheckAnnotations(
  check_run_id: number,
  annotations: OctokitAnnotation[],
  title: string,
  summary: string
): Promise<ChecksUpdateResponse> {
  return octokit.rest.checks.update({
    owner,
    repo,
    check_run_id,
    status: 'completed',
    conclusion: 'failure',
    output: {
      title,
      summary,
      annotations
    }
  })
}

async function createCheckAnnotations(
  annotations: OctokitAnnotation[]
): Promise<void> {
  const chunkSize = 50
  const annotationCount = annotations.length
  const firstAnnotations = annotations.slice(0, chunkSize)
  const title = `${annotationCount} ${
    annotationCount === 1 ? 'problem' : 'problems'
  } found`
  const summary = `I found ${annotationCount} ${
    annotationCount === 1 ? 'problem' : 'problems'
  } while reviewing your project.`

  // Push first 50 annotations
  const check = await octokit.rest.checks.create({
    owner,
    repo,
    name: checkName,
    head_sha,
    status: 'completed',
    conclusion: 'failure',
    output: {
      title,
      summary,
      annotations: firstAnnotations
    }
  })

  // Push remaining annotations, 50 at a time
  for (let i = chunkSize, len = annotations.length; i < len; i += chunkSize) {
    await updateCheckAnnotations(
      check.data.id,
      annotations.slice(i, i + chunkSize),
      title,
      summary
    )
  }
}

function issueErrors(annotations: OctokitAnnotation[]): void {
  for (const annotation of annotations) {
    issueError(annotation.title || annotation.message, {
      file: annotation.path,
      line: annotation.start_line,
      col: annotation.start_column || 0
    })
  }
}

async function run(): Promise<void> {
  try {
    const report = await runElmReview()

    if (report.type === 'error') {
      reportCliError(report)
      return
    }

    const annotations = reportErrors(report)
    const annotationCount = annotations.length

    if (detectFork()) {
      if (annotationCount > 0) {
        issueErrors(annotations)

        core.setFailed(
          `I found ${annotationCount} ${
            annotationCount === 1 ? 'problem' : 'problems'
          } while reviewing your project.`
        )
      }
    } else {
      if (annotationCount > 0) {
        await createCheckAnnotations(annotations)
      } else {
        await createCheckSuccess()
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    try {
      const error = JSON.parse(e.message)
      reportCliError(error)
    } catch (_) {
      reportCliError(e)
    }
  }
}

run()
