import * as dns from 'dns'
dns.setDefaultResultOrder('ipv4first')
import { sql } from '../lib/db'

async function run() {
  console.log('Dropping legacy column selected_repo...')
  try {
    await sql`ALTER TABLE users DROP COLUMN IF EXISTS selected_repo`
    console.log('Legacy column dropped successfully.')
    process.exit(0)
  } catch (error) {
    console.error('Failed to drop column:', error)
    process.exit(1)
  }
}

run()
