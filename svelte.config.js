import nodeAdapter from '@sveltejs/adapter-node';
import vercelAdapter from '@sveltejs/adapter-vercel';

const adapter = process.env.VERCEL
	? vercelAdapter({ runtime: 'nodejs24.x', regions: ['bom1'], maxDuration: 300 })
	: nodeAdapter();

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter,
		alias: {
			$components: './src/lib/components',
			$server: './src/lib/server',
			$types: './src/lib/types'
		}
	}
};

export default config;
