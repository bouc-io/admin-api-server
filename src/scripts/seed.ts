import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const BOUC_ORG_ID = 'a0000000-0000-4000-8000-000000000001';
const PUBLIC_ORG_ID = 'a0000000-0000-4000-8000-000000000002';

const USE_CASES = ['chatbot', 'agent_plan', 'agent_execution', 'memory_distiller', 'memory_embedding'];

async function main() {
    // Seed default organizations
    console.log('Seeding organizations...');

    await prisma.organization.upsert({
        where: { slug: 'bouc-io' },
        update: {},
        create: { id: BOUC_ORG_ID, name: 'Bouc.io', slug: 'bouc-io', tier: 'internal' },
    });
    console.log(`  upserted org: bouc-io (${BOUC_ORG_ID})`);

    await prisma.organization.upsert({
        where: { slug: 'public' },
        update: {},
        create: { id: PUBLIC_ORG_ID, name: 'Public', slug: 'public', tier: 'free' },
    });
    console.log(`  upserted org: public (${PUBLIC_ORG_ID})`);

    // Seed LLM assignment use cases for both default orgs.
    // Use findFirst + create (no upsert) because use_case is no longer @unique —
    // uniqueness is enforced by two partial DB indexes (global + per-org), which
    // Prisma cannot express natively. Each use case gets one row per org.
    console.log('Seeding LlmAssignment use cases...');

    for (const org_id of [BOUC_ORG_ID, PUBLIC_ORG_ID]) {
        for (const use_case of USE_CASES) {
            const existing = await prisma.llmAssignment.findFirst({
                where: { use_case, org_id },
            });
            if (!existing) {
                await prisma.llmAssignment.create({
                    data: { use_case, org_id },
                });
                console.log(`  created: ${use_case} (org: ${org_id})`);
            } else {
                console.log(`  exists:  ${use_case} (org: ${org_id})`);
            }
        }
    }

    console.log('Seed complete.');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
