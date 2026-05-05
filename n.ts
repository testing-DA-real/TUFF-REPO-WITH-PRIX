import {Probot} from 'probot'
import {Options} from './src/options'
import {Prompts} from './src/prompts'
import {run as runAudit} from './src/review'
import {run as runChat} from './src/review-comment'
import {als} from './src/context'
import {setOctokit} from './src/octokit'
import {recordPROutcome} from './src/review'
import {checkoutRepo} from './src/checkout'
import {rmSync} from 'fs'
import {join} from 'path'
import {tmpdir} from 'os'
import {initSentry, Sentry} from './src/monitoring/sentry'
import {trackEvent, trackError} from './src/analytics/events'
import {verifyEligibility, logAuditCompletion} from './src/eligibility'

/**
 * PRIX (AI PR Reviewer and Auditor)
 * Probot Service Entry Point
 */
export default (app: Probot) => {
  // Initialize error monitoring
  initSentry()
  
  app.log.info('PRIX Service Started')
  trackEvent("SERVICE_STARTED", { version: process.env.npm_package_version })

  // SECURITY: Webhook secret verification is handled automatically by Probot
  // Probot rejects requests with invalid/missing signatures when WEBHOOK_SECRET is set
  if (!process.env.WEBHOOK_SECRET) {
    app.log.error(
      'SECURITY WARNING: WEBHOOK_SECRET not set. Webhook verification is DISABLED.'
    )
    app.log.error(
      'Set WEBHOOK_SECRET environment variable to secure your webhooks.'
    )
    // Continue anyway for development, but log stern warning
  }

  // Sanitize Private Key (handles mangled newlines from environment variables)
  if (process.env.PRIVATE_KEY) {
    process.env.PRIVATE_KEY = process.env.PRIVATE_KEY.replace(/\\n/g, '\n') // Fix literal \n
      .replace(/^"(.*)"$/, '$1') // Remove surrounding quotes
  }

  // Helper to initialize options from environment variables
  const getOptions = () => {
    return new Options(
      true, // Hardcoded DEBUG to true
      process.env.DISABLE_REVIEW === 'true',
      process.env.DISABLE_RELEASE_NOTES === 'true',
      process.env.MAX_FILES || '0',
      process.env.REVIEW_SIMPLE_CHANGES === 'true',
      process.env.REVIEW_COMMENT_LGTM === 'true',
      process.env.PATH_FILTERS ? process.env.PATH_FILTERS.split(',') : null,
      process.env.SYSTEM_MESSAGE || '',
      'groq/compound', // Hardcoded LIGHT_MODEL
      'llama-3.3-70b-versatile', // Hardcoded HEAVY_MODEL
      process.env.MODEL_TEMPERATURE || '0.0',
      process.env.RETRIES || '3',
      process.env.TIMEOUT_MS || '120000',
      // Bug #4 Fix: concurrency of 1 ensures TokenThrottler works correctly.
      process.env.CONCURRENCY_LIMIT || '1',
      process.env.GITHUB_CONCURRENCY_LIMIT || '3',
      'https://api.groq.com/openai/v1', // Hardcoded API_BASE_URL
      process.env.LANGUAGE || 'en-US',
      true, // Hardcoded for autonomous fix PRs
      process.env.ENABLE_AUTO_PR === 'true' // SECURITY: explicit opt-in required
    )
  }

  // 1. Event Listeners for PR Audit
  app.on(
    [
      'pull_request.opened',
      'pull_request.synchronize',
      'pull_request.reopened'
    ],
    async context => {
      const {payload} = context
      const prNumber = payload.pull_request.number
      const repo = context.repo()
      
      app.log.info(
        `Received ${context.name}.${payload.action} for PR #${prNumber}`
      )
      
      trackEvent("PR_REVIEW_STARTED", { 
        prNumber, 
        repo: `${repo.owner}/${repo.repo}`,
        action: payload.action 
      })

      // --- ELIGIBILITY GATE ---
      try {
        const githubId = payload.repository.owner.id
        const repoFullName = payload.repository.full_name
        const isPrivate = payload.repository.private

        const eligibility = await verifyEligibility(githubId, repoFullName, isPrivate)

        if (!eligibility.eligible) {
          app.log.info(`Skipping audit for ${repoFullName}: ${eligibility.reason}`)
          trackEvent("AUDIT_SKIPPED", {
            repo: repoFullName,
            reason: eligibility.reason,
            plan: eligibility.plan,
            prsUsed: eligibility.prsUsed
          })
          return // Silent skip
        }
        
        app.log.info(`Eligibility verified for ${repoFullName} (Plan: ${eligibility.plan})`)
      } catch (eligibilityErr: any) {
        app.log.error(`Error during eligibility check: ${eligibilityErr.message}`)
        // Fallback: If DB is down, we might want to fail-open or fail-closed.
        // Failing-closed (return) is safer for business logic.
        return 
      }
      // --- END ELIGIBILITY GATE ---

      try {
        const options = getOptions()
        const prompts = new Prompts()

        // Create a unique temporary directory for this audit
        const tempDir = join(
          tmpdir(),
          `prix_audit_${payload.pull_request.id}_${Date.now()}`
        )

        // Create a safe, isolated execution context
        await als.run(
          {
            probotContext: context,
            octokit: context.octokit,
            repo: context.repo(),
            workingDir: tempDir
          },
          async () => {
            try {
              // Clone the repo locally so Git commands work
              await checkoutRepo(tempDir)

              // Initialize shims
              setOctokit(context.octokit)

              // Trigger the main PRIX Audit
              await runAudit(context, options, prompts)
              
              trackEvent("PR_REVIEW_COMPLETED", { 
                prNumber, 
                repo: `${repo.owner}/${repo.repo}` 
              })

              // Log audit completion to Supabase
              try {
                const githubId = payload.repository.owner.id
                const repoFullName = payload.repository.full_name
                await logAuditCompletion(githubId, repoFullName, prNumber)
                app.log.info(`Successfully logged audit completion for ${repoFullName} PR #${prNumber}`)
              } catch (logErr: any) {
                app.log.error(`Failed to log audit completion: ${logErr.message}`)
                // Don't throw here, the audit itself was successful
              }
            } catch (auditErr: any) {
              Sentry?.captureException?.(auditErr, {
                extra: { prNumber, repo, tempDir }
              })
              trackError(auditErr, { prNumber, repo, flow: "audit" })
              throw auditErr
            } finally {
              // Cleanup temp directory
              try {
                rmSync(tempDir, {recursive: true, force: true})
              } catch (cleanupErr: any) {
                app.log.error(`Failed to cleanup ${tempDir}: ${cleanupErr.message}`)
                console.error("Cleanup failed", { tempDir, error: cleanupErr.message })
              }
            }
          }
        )

        app.log.info(
          `Successfully processed audit for PR #${prNumber}`
        )
      } catch (err: any) {
        Sentry?.captureException?.(err, { extra: { prNumber, repo } })
        trackError(err, { prNumber, repo, flow: "pr_review" })
        
        const errorMessage = err.message || "Unknown error"
        app.log.error(
          `PR audit failed — PR #${prNumber}: ${errorMessage}`
        )
        console.error("PR_REVIEW_FAILED", { 
          prNumber, 
          repo, 
          error: errorMessage 
        })
        // Log specific reason without crashing as per requirements
      }
    }
  )

  // 3. Event Listeners for PR Outcome Tracking (Learning Loop)
  app.on('pull_request.closed', async context => {
    const {payload} = context
    const pr = payload.pull_request
    const repo = context.repo()

    // Only track PRs that were created by the bot (auto-remedy PRs)
    const isBotPR =
      pr.user?.login === 'github-actions[bot]' ||
      pr.user?.type === 'Bot' ||
      pr.title.includes('[AI-REMEDY]')

    if (!isBotPR) return

    try {
      await als.run(
        {
          probotContext: context,
          octokit: context.octokit,
          repo: context.repo()
        },
        async () => {
          setOctokit(context.octokit)

          if (pr.merged) {
            recordPROutcome('accepted')
            trackEvent("AUTO_PR_ACCEPTED", { 
              prNumber: pr.number, 
              repo: `${repo.owner}/${repo.repo}` 
            })
            app.log.info(
              `📊 Learning: Bot PR #${pr.number} was merged (accepted)`
            )
          } else {
            recordPROutcome('rejected')
            trackEvent("AUTO_PR_REJECTED", { 
              prNumber: pr.number, 
              repo: `${repo.owner}/${repo.repo}` 
            })
            app.log.info(
              `📊 Learning: Bot PR #${pr.number} was closed without merge (rejected)`
            )
          }
        }
      )
    } catch (err: any) {
      Sentry?.captureException?.(err, { extra: { prNumber: pr.number, repo } })
      trackError(err, { prNumber: pr.number, repo, flow: "pr_outcome" })
      app.log.error(`Failed to record PR outcome — PR #${pr.number}: ${err.message}`)
    }
  })

  app.on('pull_request.edited', async context => {
    const {payload} = context
    const pr = payload.pull_request
    const repo = context.repo()

    // Only track PRs that were created by the bot
    const isBotPR =
      pr.user?.login === 'github-actions[bot]' ||
      pr.user?.type === 'Bot' ||
      pr.title.includes('[AI-REMEDY]')

    if (!isBotPR) return

    try {
      await als.run(
        {
          probotContext: context,
          octokit: context.octokit,
          repo: context.repo()
        },
        async () => {
          setOctokit(context.octokit)
          recordPROutcome('modified')
          trackEvent("AUTO_PR_MODIFIED", { 
            prNumber: pr.number, 
            repo: `${repo.owner}/${repo.repo}` 
          })
          app.log.info(
            `📊 Learning: Bot PR #${pr.number} was edited by user (modified)`
          )
        }
      )
    } catch (err: any) {
      Sentry?.captureException?.(err, { extra: { prNumber: pr.number, repo } })
      trackError(err, { prNumber: pr.number, repo, flow: "pr_modified" })
      app.log.error(`Failed to record PR modification — PR #${pr.number}: ${err.message}`)
    }
  })

  // 4. Event Listener for "Chat with Bot" (Reply to comments)
  app.on('pull_request_review_comment.created', async context => {
    const {payload} = context
    const commentId = payload.comment.id
    const prNumber = payload.pull_request?.number
    const repo = context.repo()

    // Safety check: ensure it's not the bot replying to itself is handled inside runChat/handleReviewComment
    app.log.info(
      `Received ${context.name}.${payload.action} for comment ${commentId}`
    )
    
    trackEvent("CHAT_REPLY_STARTED", { 
      commentId, 
      prNumber, 
      repo: `${repo.owner}/${repo.repo}` 
    })

    try {
      const options = getOptions()
      const prompts = new Prompts()

      // Create a safe, isolated execution context for this event
      await als.run(
        {
          probotContext: context,
          octokit: context.octokit,
          repo: context.repo()
        },
        async () => {
          // Initialize shims for legacy compatibility
          setOctokit(context.octokit)

          // Trigger the "Chat with Bot" logic
          await runChat(context, options, prompts)
          
          trackEvent("CHAT_REPLY_COMPLETED", { 
            commentId, 
            prNumber, 
            repo: `${repo.owner}/${repo.repo}` 
          })
        }
      )

      app.log.info(
        `Successfully processed chat reply for comment ${commentId}`
      )
    } catch (err: any) {
      Sentry?.captureException?.(err, { extra: { commentId, prNumber, repo } })
      trackError(err, { commentId, prNumber, repo, flow: "chat_reply" })
      app.log.error(
        `Chat reply failed — comment ${commentId}: ${err.message}`
      )
      console.error("CHAT_REPLY_FAILED", { 
        commentId, 
        prNumber, 
        repo, 
        error: err.message 
      })
    }
  })
}
