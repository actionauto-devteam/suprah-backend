import * as ftp from 'basic-ftp';
import { parse } from 'csv-parse';
import { Readable } from 'stream';
import config from '../config';
import { ApiError } from '../utils/ApiError';

export interface RawVehicleData {
    vin: string;
    make: string;
    model: string;
    year: string;
    trim: string;
    price: string;
    mileage: string;
    'picture urls': string;
    'exterior color': string;
    'dealer comments on vehicle': string;
    'stock number': string;
    'transmission type': string;
    'installed options': string;
    'dealer id': string;
    'dealer name': string;
    'dealer street address': string;
    'dealer city': string;
    'dealer state': string;
    'dealer zip': string;
    'dealer crm email': string;
    'interior color': string;
    certified: string;
    'is new': string;
    engine: string;
    vehicletype: string;
    vdp_vin_url: string;
}

export class FtpService {
    async getInventoryStream(): Promise<Readable> {
        const { host, user, password, file } = config.ftp;

        if (!host || !user || !password) {
            throw new ApiError(400, 'FTP credentials missing in .env');
        }

        const client = new ftp.Client();
        client.ftp.verbose = config.env === 'development';

        try {
            await client.access({
                host,
                user,
                password,
                secure: false,
            });

            const stream = new Readable({
                read() { },
            });

            await client.downloadTo(stream as any, file);
            client.close();

            return stream;
        } catch (err: any) {
            client.close();
            throw new ApiError(500, `FTP Connection Failed: ${err.message}`);
        }
    }

    /**
     * Parses the CSV stream into raw vehicle objects
     */
    async parseInventoryFile(stream: Readable): Promise<RawVehicleData[]> {
        return new Promise((resolve, reject) => {
            const results: RawVehicleData[] = [];

            stream
                .pipe(
                    parse({
                        columns: (header) => header.map(h => h.trim().toLowerCase()),
                        skip_empty_lines: true,
                        trim: true,
                        relax_quotes: true,
                        relax_column_count: true,
                        skip_records_with_error: true,
                        delimiter: '\t', // DealersCloud TSV format
                    })
                )
                .on('data', (data) => results.push(data))
                .on('error', (err) => reject(new ApiError(500, `CSV Parsing Failed: ${err.message}`)))
                .on('end', () => resolve(results));
        });
    }
}

export default new FtpService();
