import dns from 'dns';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const resolveSrv = promisify(dns.resolveSrv);
const resolve4 = promisify(dns.resolve4);

const CLUSTER_DOMAIN = '_mongodb._tcp.test-cluster.a2dm96u.mongodb.net';
const OUTPUT_FILE = path.join(__dirname, 'resolved-ips.json');

async function diagnose() {
    const result: any = { srv: [], hosts: {} };

    try {
        const addresses = await resolveSrv(CLUSTER_DOMAIN);
        result.srv = addresses;

        for (const addr of addresses) {
            try {
                const ips = await resolve4(addr.name);
                result.hosts[addr.name] = ips;
            } catch (e: any) {
                result.hosts[addr.name] = { error: e.code };
            }
        }

        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
        console.log('Done writing to file.');
    } catch (error: any) {
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ error: error.message }, null, 2));
    }
}

diagnose();