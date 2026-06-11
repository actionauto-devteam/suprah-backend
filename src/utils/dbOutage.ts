export const DB_OUTAGE_MESSAGE =
    "We're temporarily experiencing technical issues on our end. Your account and data are safe — please try again in a few minutes.";

const OUTAGE_NAME_PATTERNS = [
    'MongoNetworkError',
    'MongoServerSelectionError',
    'MongooseServerSelectionError',
    'MongoTopologyClosedError',
    'MongoNotConnectedError',
];

const OUTAGE_MESSAGE_PATTERN =
    /space quota|writes are blocked|over your space quota|buffering timed out|server selection timed out|topology (was |is )?(closed|destroyed)|ECONNREFUSED.*:270\d\d|getaddrinfo ENOTFOUND.*mongodb/i;

export const isQuotaExceededError = (err: any): boolean => {
    const message = String(err?.message || err?.errmsg || '');
    return (
        /space quota|writes are blocked/i.test(message) ||
        (err?.code === 8000 && /quota/i.test(message))
    );
};

export const isDbOutageError = (err: any): boolean => {
    if (!err) return false;
    if (err.name === 'ValidationError' || err.name === 'CastError') return false;

    if (isQuotaExceededError(err)) return true;
    if (OUTAGE_NAME_PATTERNS.includes(err.name)) return true;

    const message = String(err.message || err.errmsg || '');
    if (OUTAGE_MESSAGE_PATTERN.test(message)) return true;

    if (err.cause && err.cause !== err) return isDbOutageError(err.cause);
    return false;
};
