module.exports.action = (inputs, ctx) => {
  ctx.log.info('action greeted ' + inputs.name);
  return { message: 'hello ' + inputs.name };
};
