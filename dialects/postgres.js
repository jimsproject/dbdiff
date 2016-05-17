var dbdiff = require('../')
var querystring = require('querystring')
var pync = require('pync')
var PostgresClient = require('./postgres-client')

class PostgresDialect {
  describeDatabase (options) {
    var conString
    if (typeof options === 'string') {
      conString = options
    } else {
      var dialectOptions = Object.assign({}, options.dialectOptions)
      Object.keys(dialectOptions).forEach((key) => {
        var value = dialectOptions[key]
        if (typeof value === 'boolean') {
          dialectOptions[key] = value ? 'true' : 'false'
        }
      })
      var query = querystring.stringify(dialectOptions)
      if (query.length > 0) query = '?' + query
      conString = `postgres://${options.username}:${options.password}@${options.host}:${options.port || 5432}/${options.database}${query}`
    }

    var schema = {}
    var client = new PostgresClient(conString)
    return client.find('SELECT * FROM pg_tables WHERE schemaname NOT IN ($1, $2, $3)', ['temp', 'pg_catalog', 'information_schema'])
      .then((tables) => (
        pync.map(tables, (table) => {
          var t = {
            name: table.tablename,
            schema: table.schemaname,
            indexes: []
          }
          return client.find(`
            SELECT
              table_name,
              table_schema,
              column_name,
              data_type,
              udt_name,
              character_maximum_length,
              is_nullable,
              column_default
            FROM
              INFORMATION_SCHEMA.COLUMNS
            WHERE
              table_name=$1 AND table_schema=$2;`, [table.tablename, table.schemaname])
          .then((columns) => {
            t.columns = columns.map((column) => ({
              name: column.column_name,
              nullable: column.is_nullable === 'YES',
              defaultValue: column.column_default,
              type: dataType(column)
            }))
            return t
          })
        })
      ))
      .then((tables) => {
        schema.tables = tables
        return client.find(`
          SELECT
            i.relname as indname,
            i.relowner as indowner,
            idx.indrelid::regclass,
            idx.indisprimary,
            idx.indisunique,
            am.amname as indam,
            idx.indkey,
            ARRAY(
              SELECT pg_get_indexdef(idx.indexrelid, k + 1, true)
              FROM generate_subscripts(idx.indkey, 1) as k
              ORDER BY k
            ) AS indkey_names,
            idx.indexprs IS NOT NULL as indexprs,
            idx.indpred IS NOT NULL as indpred,
            ns.nspname
          FROM
            pg_index as idx
          JOIN pg_class as i
            ON i.oid = idx.indexrelid
          JOIN pg_am as am
            ON i.relam = am.oid
          JOIN pg_namespace as ns
            ON ns.oid = i.relnamespace
            AND ns.nspname NOT IN ('pg_catalog', 'pg_toast');
        `)
      })
      .then((indexes) => {
        indexes.forEach((index) => {
          var table = schema.tables.find((table) => table.name === index.indrelid && table.schema === index.nspname)
          table.indexes.push({
            name: index.indname,
            schema: table.schema,
            primary: index.indisprimary,
            unique: index.indisunique,
            type: index.indam,
            keys: index.indkey_names
          })
        })
        return client.find('SELECT * FROM information_schema.sequences')
      })
      .then((sequences) => {
        schema.sequences = sequences.map((sequence) => {
          sequence.schema = sequence.sequence_schema
          sequence.name = sequence.sequence_name
          sequence.cycle = sequence.cycle_option === 'YES'
          delete sequence.sequence_name
          delete sequence.sequence_catalog
          delete sequence.sequence_schema
          delete sequence.cycle_option
          return sequence
        })
        client.end()
        return schema
      })
      .catch((err) => {
        client.end()
        return Promise.reject(err)
      })
  }
}

function dataType (info) {
  var type
  if (info.data_type === 'ARRAY') {
    type = info.udt_name
    if (type.substring(0, 1) === '_') {
      type = type.substring(1)
    }
    type += '[]'
  } else if (info.data_type === 'USER-DEFINED') {
    type = info.udt_name // hstore for example
  } else {
    type = info.data_type
  }

  if (info.character_maximum_length) {
    type = type + '(' + info.character_maximum_length + ')'
  }
  return type
}

dbdiff.register('postgres', PostgresDialect)