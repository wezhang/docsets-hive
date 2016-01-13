'use strict';

var gulp = require('gulp');
var swig = require('gulp-swig');
var _ = require('lodash');
var path = require('path');
var sqlite = require('sql.js');
var eventStream = require('event-stream');
var gutil = require('gulp-util');
var BufferStreams = require('bufferstreams');
var foreach = require('gulp-foreach');
var concat = require('gulp-concat');
var fileBuffer = require('gulp-buffer');
var cheerio = require('cheerio');
var fs = require('fs');
var rename = require("gulp-rename");
var program = require('commander');
var yaml = require('js-yaml');

program.version('0.0.2')
  .option('-p, --plan <plan>', 'The plan to generate docsets.', 'hive')
  .parse(process.argv);


var plans = [ 'plans/*.yaml' ];

var plan = yaml.safeLoad(fs.readFileSync('plans/' + program.plan + '.yaml', 'utf8'));
var prod = plan.prod;
var name = plan.name;
var packageName = prod.replace(' ', '_')
var docsetPath = packageName + '.docset/';
var contentsPath = path.join(docsetPath, 'Contents/');
var infoPlistPath = contentsPath;
var docpath = path.join(contentsPath, 'Resources/Documents/');
var sqlitePath = path.join(contentsPath, 'Resources/docSet.dsidx');
var website = 'website/' + name + '/';
var iconSrc = path.join(website, plan.icon || 'icon.png');
var iconDst = docsetPath;

var websiteSrc = [ website + '**' ];
var htmlSrc = _.map(plan.htmlSrcPadding, function(pad) {
  return website + pad;
});

var otherSrc = _.map(plan.otherSrcPadding, function(pad) {
  return website + pad;
});

var sqls = [
  'CREATE TABLE searchIndex(id INTEGER PRIMARY KEY, name TEXT, type TEXT, path TEXT);',
  'CREATE UNIQUE INDEX anchor ON searchIndex (name, type, path);'
];

var indexes = [];

var Type = {
  INSTRUCTION: 'Instruction',
  FUNCTION: 'Function',
  CLASS: 'Class',
};
gulp.task('plist', function() {
  return gulp.src('templates/Info.j2')
    .pipe(swig({
      data: {
        CFBundleIdentifier: name,
        CFBundleName: prod,
        DocSetPlatformFamily: name,
        isJavaScriptEnabled: true,
        dashIndexFilePath: plan.index || undefined
      },
      ext: '.plist'
    }))
    .pipe(gulp.dest(infoPlistPath));
});

gulp.task('sqlite', ['webpages'], function() {
  var db = new sqlite.Database();

  db.run(sqls.join('\n'));

  _(indexes)
    .chunk(10)
    .forEach(function(subIndexes) {
      var values = _(subIndexes)
        .map(function(v) {
          var value = "('" + v.name + "','" + v.type + "','" + v.path + "')";
          //var value = '("' + v.name + '","' + v.type + '","' + v.path + '")';
          //console.log(value);

          return value;
        })
        .value()
        .join(',');

      var indexSql = 'INSERT OR REPLACE INTO searchIndex(name, type, path) VALUES ' + values + ';';

      db.run(indexSql);

    })
    .value();
  var data = db.export();
  var buffer = new Buffer(data);
  return fs.writeFileSync(sqlitePath, buffer);
});

gulp.task('other', function() {
  return gulp.src(otherSrc)
    .pipe(gulp.dest(docpath));
});

gulp.task('icon', function() {
  return gulp.src(iconSrc)
    .pipe(gulp.dest(iconDst));
});

gulp.task('webpages', ['other', 'icon'], function() {
  return gulp.src(htmlSrc)
    .pipe(rename(function(filepath) {
      if (filepath.extname !== '.html') {
        filepath.extname = '.html';
      }
    }))
    .pipe(handlePage)
    .pipe(gulp.dest(docpath));
});

gulp.task('pack', ['plist', 'sqlite'], function () {
  var tar = require('gulp-tar');
  var gzip = require('gulp-gzip');

  return gulp.src(['!**/+(\.DS_Store)/**', docsetPath + '**'], { base: './' } )
    .pipe(tar(name + '.tar'))
    .pipe(gzip())
    .pipe(rename(packageName + '.tgz'))
    .pipe(gulp.dest('target'));
});

gulp.task('default', ['plist', 'sqlite', 'pack']);

//var handlePage = eventStream.map(function(buffer, callback) {
//  console.log(buffer);
//  callback(null, 'hello world');
//});

var handlePage = eventStream.map(function(file, callback) {
  var relativePath = path.relative(path.join(process.cwd(), website), file.path);

  if (file.isNull()) {
    // Nothing to do if no contents
    callback(null, file);
  } else if (file.isStream()) {
    file.contents = file.contents.pipe(new BufferStreams(function(err, buf, cb) {
      try {
        if (err) {
          return cb(new gutil.PluginError('handlePage', err.message));
        }
        cb(null, handleDom(buf, relativePath));
      } catch (err) {
        cb(new gutil.PluginError('handlePage', err.message));
      }
    }));
      callback(null, file);
  } else if (file.isBuffer()) {
    try {
      file.contents = handleDom(file.contents, relativePath);
      callback(null, file);
    }
    catch (err) {
      callback(err, null);
    }
  }
});

var handleDom = function(buffer, filepath) {
  var $ = cheerio.load(buffer);

  // remove
  plan.selectors.remove.forEach(function(selector) {
    $(selector).remove();
  });

  // Remove splitter class
  plan.selectors.removeClass.forEach(function(item) {
    $(item.selector).removeClass(item['class']);
  });

  // Add keyword
  plan.selectors.keyword.forEach(function(keyword) {
    if (keyword.url && filepath !== keyword.url) {
      // url doesn't match
      return;
    }

    $(keyword.selector).each(function(i, elem) {
      var name = $(elem).text();
      name = name.replace(/'/g, "\'\'").trim();

      var target;

      switch(keyword.targetAttribute) {
      case 'href':
        var basepath = path.dirname(filepath);
        target = path.join(basepath, $(elem).attr('href'));
        break;
      case 'id': // falling down
      default:
        target = filepath + '#' + $(elem).attr('id');
      }

      target = target.replace(/'/g, "\'\'");

      if (name) {
        index(name, keyword.type, target);
      }
    });
  });

  return Buffer($.html());
};

var index = function(name, type, target) {
  indexes.push({
    name: name,
    type: type,
    path: target
  });
};
