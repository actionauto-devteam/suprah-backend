import * as ftp from 'basic-ftp';
import { parse } from 'csv-parse';
import { Readable } from 'stream';
import config from '../config';
import { ApiError } from '../utils/ApiError';

export interface RawVehicleData {
    Year: string;
    Make: string;
    Model: string;
    Trim: string;
    Color: string;
    Engine: string;
    VIN: string;
    Mileage: string;
    Cost: string;
    'J.D. POWER Adj': string;
    'Internet Price': string;
    'Retail Price': string;
    Age: string;
    StockNumber: string;
}

/**
 * Service to handle FTP operations with DealersCloud
 */
export class FtpService {
    /**
     * Downloads the inventory file from FTP and returns a stream
     */
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
                secure: false, // DealersCloud usually uses plain FTP or explicit TLS
            });

            // Stream the file into memory/parser
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
                        columns: true, // Uses first row as headers
                        skip_empty_lines: true,
                        trim: true,
                    })
                )
                .on('data', (data) => results.push(data))
                .on('error', (err) => reject(new ApiError(500, `CSV Parsing Failed: ${err.message}`)))
                .on('end', () => resolve(results));
        });
    }
}

export default new FtpService();
