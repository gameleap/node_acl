/**
  MongoDB Backend.
  Implementation of the storage backend using MongoDB
*/
"use strict";

var contract = require("./contract");
var async = require("async");
var _ = require("lodash");

// Name of the collection where meta and allowsXXX are stored.
// If prefix is specified, it will be prepended to this name, like acl_resources
var aclCollectionName = "resources";

function MongoDBBackend({ client, db, prefix, useSingle, useRawCollectionNames }) {
    this.client = client;
    this.db = db || client.db(client.s.options.dbName);
    this.prefix = typeof prefix !== "undefined" ? prefix : "acl_";
    this.useSingle = Boolean(useSingle);
    this.useRawCollectionNames = useRawCollectionNames === false; // requires explicit boolean false value
}

MongoDBBackend.prototype = {
    close(cb) {
        if (this.client) this.client.close(cb);
        else cb();
    },

    /**
     Begins a transaction.
  */
    begin() {
        // returns a transaction object(just an array of functions will do here.)
        return [];
    },

    /**
     Ends a transaction (and executes it)
  */
    end(transaction, cb) {
        contract(arguments).params("array", "function").end();
        async.series(transaction, function (err) {
            cb(err instanceof Error ? err : undefined);
        });
    },

    /**
    Cleans the whole storage.
  */
    clean(cb) {
        contract(arguments).params("function").end();
        this.db.collections(function (err, collections) {
            if (err instanceof Error) return cb(err);
            async.forEach(
                collections,
                function (coll, innercb) {
                    coll.drop(function () {
                        innercb();
                    }); // ignores errors
                },
                cb
            );
        });
    },

    /**
     Gets the contents at the bucket's key.
  */
    async get(bucket, key, cb) {
        contract(arguments).params("string", "string|number", "function").end();
        key = encodeText(key);
        var searchParams = this.useSingle ? { _bucketname: bucket, key: key } : { key: key };
        var collName = this.useSingle ? aclCollectionName : bucket;

        let collection = this.db.collection(this.prefix + this.removeUnsupportedChar(collName));

        if (!collection) return cb(new Error(`Cannot find the collection ${collName}`));

        // Excluding bucket field from search result
        try {
            let doc = await collection.findOne(searchParams, { projection: { _bucketname: 0 } });
            if (!_.isObject(doc)) return cb(undefined, []);
            doc = fixKeys(doc);
            cb(undefined, _.without(_.keys(doc), "key", "_id", "_bucketname"));
        } catch (err) {
            return cb(err);
        }
    },

    /**
     Gets the contents at the bucket's key.
    */
    async getMany(bucket, query, field, cb) {
        contract(arguments).params("string", "object", "string|number", "function").end();
        // key = encodeText(key);
        var searchParams = this.useSingle ? { _bucketname: bucket, ...query } : { ...query };
        var collName = this.useSingle ? aclCollectionName : bucket;

        let collection = this.db.collection(this.prefix + this.removeUnsupportedChar(collName));

        if (!collection) return cb(new Error(`Cannot find the collection ${collName}`));

        // Excluding bucket field from search result
        try {
            const cursor = collection.find(searchParams, { [field]: 1 });
            const docs = await cursor.toArray();

            cb(
                undefined,
                docs.map((d) => d[field])
            );
        } catch (err) {
            return cb(err);
        }
    },

    /**
    Returns the union of the values in the given keys.
  */
    async union(bucket, keys, cb) {
        contract(arguments).params("string", "array", "function").end();
        keys = encodeAll(keys);
        var searchParams = this.useSingle ? { _bucketname: bucket, key: { $in: keys } } : { key: { $in: keys } };
        var collName = this.useSingle ? aclCollectionName : bucket;

        let collection = this.db.collection(this.prefix + this.removeUnsupportedChar(collName));

        if (!collection) return cb(new Error(`Cannot find the collection ${collName}`));

        try {
            const cursor = collection.find(searchParams, { projection: { _bucketname: 0 } });
            let docs = await cursor.toArray();

            if (!docs.length) {
                return cb(undefined, []);
            }

            var keyArrays = [];
            docs = fixAllKeys(docs);
            for (const doc of docs) {
                keyArrays.push(...Object.keys(doc));
            }
            cb(undefined, _.without(_.union(keyArrays), "key", "_id", "_bucketname"));
        } catch (err) {
            return cb(err);
        }
    },

    /**
    Adds values to a given key inside a bucket.
  */
    async add(transaction, bucket, key, values) {
        contract(arguments).params("array", "string", "string|number", "string|array|number").end();

        if (key == "key") throw new Error("Key name 'key' is not allowed.");
        key = encodeText(key);
        var collectionIndex = this.useSingle ? { _bucketname: 1, key: 1 } : { key: 1 };
        var updateParams = this.useSingle ? { _bucketname: bucket, key: key } : { key: key };
        var collName = this.useSingle ? aclCollectionName : bucket;
        transaction.push((cb) => {
            values = makeArray(values);

            let collection = this.db.collection(this.prefix + this.removeUnsupportedChar(collName));

            if (!collection) return cb(new Error(`Cannot find the collection ${collName}`));

            // build doc from array values
            var doc = {};
            for (const value of values) {
                doc[value] = true;
            }

            // update documents
            collection
                .updateMany(updateParams, { $set: doc }, { safe: true, upsert: true })
                .then(() => {
                    return cb(undefined);
                })
                .catch((err) => {
                    return cb(err);
                });
        });

        transaction.push((cb) => {
            let collection = this.db.collection(this.prefix + this.removeUnsupportedChar(collName));

            if (!collection) return cb(new Error(`Cannot find the collection ${collName}`));

            collection
                .createIndex(collectionIndex)
                .then(() => {
                    return cb(undefined);
                })
                .catch((err) => cb(err));
        });
    },

    /**
     Delete the given key(s) at the bucket
  */
    async del(transaction, bucket, keys) {
        contract(arguments).params("array", "string", "string|array").end();
        keys = makeArray(keys);
        var updateParams = this.useSingle ? { _bucketname: bucket, key: { $in: keys } } : { key: { $in: keys } };
        var collName = this.useSingle ? aclCollectionName : bucket;

        transaction.push((cb) => {
            let collection = this.db.collection(this.prefix + this.removeUnsupportedChar(collName));

            if (!collection) return cb(new Error(`Cannot find the collection ${collName}`));

            collection
                .deleteMany(updateParams, { safe: true })
                .then(() => {
                    return cb(undefined);
                })
                .catch((err) => {
                    cb(err);
                });
        });
    },

    /**
    Removes values from a given key inside a bucket.
  */
    async remove(transaction, bucket, key, values) {
        contract(arguments).params("array", "string", "string|number", "string|array|number").end();
        key = encodeText(key);
        var updateParams = this.useSingle ? { _bucketname: bucket, key: key } : { key: key };
        var collName = this.useSingle ? aclCollectionName : bucket;

        values = makeArray(values);
        transaction.push((cb) => {
            let collection = this.db.collection(this.prefix + this.removeUnsupportedChar(collName));

            if (!collection) return cb(new Error(`Cannot find the collection ${collName}`));

            // build doc from array values
            var doc = {};
            for (const value of values) {
                doc[value] = true;
            }

            // update documents
            collection
                .updateMany(updateParams, { $unset: doc }, { safe: true, upsert: true })
                .then((result) => {
                    return cb(undefined);
                })
                .catch((err) => cb(err));
        });
    },

    removeUnsupportedChar(text) {
        if (!this.useRawCollectionNames && (typeof text === "string" || text instanceof String)) {
            text = decodeURIComponent(text);
            text = text.replace(/[/\s]/g, "_"); // replaces slashes and spaces
        }
        return text;
    },
};

function encodeText(text) {
    if (typeof text == "string" || text instanceof String) {
        text = encodeURIComponent(text);
        text = text.replace(/\./g, "%2E");
    }
    return text;
}

function decodeText(text) {
    if (typeof text == "string" || text instanceof String) {
        text = decodeURIComponent(text);
    }
    return text;
}

function encodeAll(arr) {
    if (Array.isArray(arr)) {
        return arr.map(encodeText);
    } else {
        return arr;
    }
}

function fixKeys(doc) {
    if (!doc) return doc;
    return _.mapKeys(doc, (value, key) => decodeText(key));
}

function fixAllKeys(docs) {
    if (!(docs && docs.length)) return docs;
    return docs.map(fixKeys);
}

function makeArray(arr) {
    return Array.isArray(arr) ? encodeAll(arr) : [encodeText(arr)];
}

exports = module.exports = MongoDBBackend;
