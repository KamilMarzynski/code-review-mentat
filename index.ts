import * as clack from '@clack/prompts';

const mr = await clack.select({
  message: 'What MR we are working on?',
  options: [
    { label: 'feature/FOO-123 -> dev', value: 'https://example.foo123TOdev.com' },
    { label: 'feature/FOO-456 -> dev', value: 'https://example.foo456TOdev.com' },
  ],
});

console.log(`Selected MR: ${mr.toString()}`);

