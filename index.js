(function () {
  "use strict";
  let debugModule;
  try {
    debugModule = require('debug');
  } catch( e ) {
    // debug module not found, ignore and use a no-op
    debugModule = name => () => {};
  }
  const debug = {
      main: debugModule('pg-spice'),
      parsed: debugModule('pg-spice:parsed'),
      params: debugModule('pg-spice:params'),
      sql: debugModule('pg-spice:sql')
  };

  const defaults = {
    enableParseCache: true,
    allowMultipleParamTypes: false,
    trimDebugSql: process.env.PG_SPICE_TRIM_DEBUG_SQL === 'true'
  };
  const globals = {
    isPatched: false,
    options: defaults
  };
  const parseCache = {};

  const PARAMETER_SEPARATORS = ['"', '\'', ':', '&', ',', ';', '(', ')', '|', '=', '+', '-', '*', '%', '/', '\\', '<', '>', '^'];
  const START_SKIP = ["'", "\"", "--", "/*"];
  const STOP_SKIP  = ["'", "\"", "\n", "*/"];

  function skipCommentsAndQuotes(sql, position) {
    var i, j, m, n, match, offset, endMatch, endPos;
    for(i=0;i<START_SKIP.length;i++) {
      if( sql[position] == START_SKIP[i][0] ) {
        match = true;
        for(j=1;j<START_SKIP[i].length;j++) {
          if( sql[position+j] != START_SKIP[i][j] ) {
            match = false;
            break;
          }
        }
        if( match ) {
          offset = START_SKIP[i].length;
          for(m=position+offset;m<sql.length;m++) {
            if( sql[m] == STOP_SKIP[i][0] ) {
              endMatch = true;
              endPos = m;
              for(n=1;n<STOP_SKIP[i].length;n++) {
                if( (m+n) >= sql.length ) {
                  // multi char skip not properly closed
                  return sql.length;
                }
                if( sql[m+n] != STOP_SKIP[i][n] ) {
                  endMatch = false;
                  break;
                }
                endPos = m + n;
              }
              if( endMatch ) {
                return endPos + 1;
              }
            }
          }
          // comment or qutoe not closed properly
          return sql.length;
        }
      }
    }
    return position;
  }

  function isParamSeparator(c) {
    return /\s/.test(c) ? true : PARAMETER_SEPARATORS.some(par => par === c);
  }

  function parseSql(stmt) {
    let ret;
    if( globals.options.enableParseCache ) {
      ret = parseCache[stmt];
      if( ret ) {
        return ret;
      }
    }
    ret = _parseSql(stmt);
    if( globals.options.enableParseCache ) {
      parseCache[stmt] = ret;
    }
    return ret;
  }

  /**
   * Parses sql for named parameters 
   *
   * Returns a list of named parameters found in the sql
   *   sql - the parsed sql with parameters replaced with $X placeholders
   *   originalSql - the original sql passed in as a parameter
   *   params[] - list of parsed parameters
   *     
   * Each entry of params[] has the following properties:
   *   name - the name of the parameter
   *   indexes[] - the list of indexes, one-orgin, of the parameter
   */
  function _parseSql(stmt) {
    var params = [];
    var i = 0, j;
    if( typeof stmt !== 'string' ) {
      throw new Error("stmt argument must be a string, given: " + typeof(stmt));
    }
    while( i < stmt.length ) {
      var skipToPosition = i;
      while( i < stmt.length ) {
        skipToPosition = skipCommentsAndQuotes(stmt, i);
        if( i == skipToPosition ) {
          break;
        } else {
          i = skipToPosition;
        }
      }
      if( i>= stmt.length ) {
        break;
      }
      var c = stmt[i];
      if( c == ':' || c == '&' || c == '$' ) {
        j = i + 1;
        if( j < stmt.length && c == ':' && stmt[j] == ':' ) {
          // Postgres-style "::" cast (skip)
          i = i + 2;
          continue;
        }
        if( j < stmt.length && c == ':' && stmt[j] == '{' ) {
          // :{foobar} style parameter
          while( j < stmt.length && '}' != stmt[j] ) {
            j++;
            if( ':' == stmt[j] || '{' == stmt[j] ) {
              throw new Error("Parameter name contains invalid character '" + 
                     stmt[j] + 
                     "' at position " + i + " in statement " + stmt);
            }
          }
          if( j >= stmt.length ) {
            throw new Error("Non-terminated named parameter declaration" + 
                   " at position " + i + " in statement " + stmt);
          }
          if( (j-i) > 3 ) {
            params.push({
              name: stmt.substring(i+2, j),
              start: i,
              end: j+1,
              type: ':{}'
            });
          }
          j++;
        } else {
          // :foobar or $foobar style parameter
          while( j < stmt.length && !isParamSeparator(stmt[j]) ) {
            j++;
          }
          if( (j-i) > 1 ) {
           params.push({
              name: stmt.substring(i+1, j),
              start: i,
              end: j,
              type: stmt[i]
            });
          }
        }
        i = j - 1;
      } else {
        if( c == '\\' ) {
          j = i + 1;
          if( j < stmt.length && stmt[j] == ':' ) {
            // escaped ":" (skip)
            i = i + 2;
            continue;
          }
        }
        if( c == '?' ) {
          // unamed param?
        }
        if( c == '$' ) {
          // unamed param?
        }
      }
      i++;
    }
    var ret = {
      "sql": stmt,
      "originalSql": stmt,
      "params": [],
      "numParams": params.length,
      "numDistinctParams": 0
    };
    var param;
    var namedParam;
    var paramTypes = {};
    var namedParams = {};
    for(i=0;i<params.length;i++) {
      param = params[i];
      paramTypes[param.type] = (paramTypes[param.type] || 0) + 1;
      if( /^[0-9]+$/.test(param.name) ) {
        throw new Error(`You cannot mix named and numbered parameters. Check parameter ${param.name} at position ${param.start} in statement: ${stmt}`);
      }
      namedParam = namedParams[param.name];
      if( !namedParam ) {
        // increment before we use it so it's 1-origin
        ret.numDistinctParams++;
        namedParam = {
          // :foo
          "name": param.name,
          // the $N order it appears in the sql
          "index": ret.numDistinctParams,
          // all the $N spots replaced that it appears
          "indexes": []
        };
        namedParams[param.name] = namedParam;
        // Add them in order of appearance
        ret.params.push(namedParam);
      }
      namedParam.indexes.push(i+1);
    }

    if( !globals.options.allowMultipleParamTypes ) {
      if (Object.keys(paramTypes).length > 1) {
        throw new Error(`You cannot mix multiple types of named parameters in statement: ${stmt}`);
      }
    }

    // Loop backwards so the start/end stay accurrate:
    for(i=params.length-1;i>=0;i--) {
      param = params[i];
      namedParam = namedParams[param.name];
      // "SELECT :foo FROM bar" ==> "SELECT " + $1 + " FROM bar"
      ret.sql = ret.sql.substring(0,param.start) + 
                "$" + namedParam.index +
                ret.sql.substring(param.end);
    }
    return ret;
  }

  /** 
   * Converts parameter values from object to an array. Parameter value
   * indexes come from the parsedSql object and a given parameter may
   * appear in multiple positions.
   */
  function convertParamValues(parsedSql, values) {
    const ret = [];
    parsedSql.params.forEach(param => {
      if( !values.hasOwnProperty(param.name) ) {
        throw new Error("No value found for parameter: " + param.name);
      }
      ret.push(values[param.name]);
    });
    return ret;
  }

  function filterDebugSQL(sql) {
    if( globals.options.trimDebugSql ) {
      return sql.replace(/\s+/g, " ");
    }
    return sql;
  }

  function patch(pg, options) {
    if( globals.isPatched ) {
      debug.main('Already patched, skipping');
      return;
    }
    globals.isPatched = true;
    globals.options = Object.assign(defaults, options || {});
    debug.main('Patching pg module with options:', globals.options);

    // Add named parameter support to Client.query:
    const origQuery = pg.Client.prototype.query;
    pg.Client.prototype.query = function(config, values, callback) {
      let sql = typeof config === 'string' ? config.trim() : !!config && (typeof config === 'object') && config.hasOwnProperty('text') ? config.text : '';

      if( sql ) {
        debug.sql(filterDebugSQL(sql));
      }
      if( arguments.length === 3 && !Array.isArray(values) && (!!values && (typeof values === 'object') ) ) {
        try {
          if( !sql ) {
            throw new Error("First parameter of query() must be a string or config object with a name property");
          }

          if (sql.toUpperCase().startsWith('UPDATE')) {
            const splitSql = sql.split(/\b(\w*where)\b/);
            let firstPart = splitSql[0];
            if (!!firstPart) {
              firstPart = firstPart.replace(/\w+(\s*=\s*):.*?(\w|\-)+(\s*,)?/g, val => {
                const sd  = val.split(/(\s*=\s*):.*?/g);
                const updateField = sd[0];
                const paramSplit  = sd[2].split(/,/g);
                const paramName = paramSplit[0].trim();
                const endComma = paramSplit.length === 1 ? '' : ',';
                return values.hasOwnProperty(paramName) ? `${updateField}=:${paramName}${endComma}` : '';
              });
            }
            const endPart = !!splitSql[2] ? ` where ${splitSql[2]}` : '';
            if (firstPart.trim().endsWith(',')){
              firstPart = firstPart.substring(0, firstPart.lastIndexOf(','));
            }
            sql = `${firstPart}${endPart}`;
          }
          const parsedSql = parseSql(sql);
          debug.main("parsed sql:", parsedSql);
          const params = convertParamValues(parsedSql, values);
          debug.main("parsed params:", params);
          return origQuery.apply(this, [parsedSql.sql, params, callback]);
        } catch( err ) {
          if( callback ) {
            return callback(err);
          } else {
            return;
          }
        }
      }
      return origQuery.apply(this, arguments);
    };
  }

  module.exports = {
    "patch": patch,
    // For testing:
    "parseSql": parseSql,
    "convertParamValues": convertParamValues
  };
})();
